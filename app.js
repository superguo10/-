const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "lexis-field-v1";
const DAY_MS = 86400000;

const CURRICULUM_VERSION = 3;
const defaultState = { progress: {}, plans: {}, sessions: {}, customWords: [], exampleTranslations: {}, quickLookups: {}, sound: true, curriculumVersion: CURRICULUM_VERSION };
let state = loadState();
let queue = [];
let currentIndex = 0;
let currentWord = null;
let sessionRatings = { easy: 0, good: 0, hard: 0, again: 0 };

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const loaded = { ...defaultState, ...raw };
    if (raw.curriculumVersion !== CURRICULUM_VERSION) {
      loaded.plans = {};
      loaded.curriculumVersion = CURRICULUM_VERSION;
    }
    return loaded;
  }
  catch { return { ...defaultState }; }
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function dayNumber(day) { return Math.floor(new Date(`${day}T12:00:00`).getTime() / DAY_MS); }
function addDays(day, days) {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + Math.max(0, Math.round(days)));
  return localDay(date);
}
function allWords() { return [...window.WORD_LIBRARY, ...(state.customWords || [])]; }
function wordById(id) { return allWords().find(w => w.id === id); }

function seededShuffle(items, seedText) {
  let seed = [...seedText].reduce((n, c) => ((n << 5) - n + c.charCodeAt(0)) | 0, 2166136261);
  const list = [...items];
  for (let i = list.length - 1; i > 0; i--) {
    seed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    const j = Math.abs(seed) % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function getTodayPlan() {
  const today = localDay();
  if (state.plans[today]) return state.plans[today];
  const used = new Set(Object.values(state.plans).flat());
  const choose = (type, count) => {
    let pool = allWords().filter(w => w.type === type && !used.has(w.id));
    if (pool.length < count) pool = allWords().filter(w => w.type === type);
    const levels = [...new Set(pool.map(w => w.level || 2))].sort((a, b) => a - b);
    const ordered = levels.flatMap(level => seededShuffle(pool.filter(w => (w.level || 2) === level), `${today}-${type}-${level}`));
    return ordered.slice(0, count).map(w => w.id);
  };
  state.plans[today] = [...choose("research", 10), ...choose("life", 5)];
  saveState();
  return state.plans[today];
}

function dueIds() {
  const today = localDay();
  const plan = new Set(getTodayPlan());
  return Object.entries(state.progress)
    .filter(([id, p]) => !plan.has(id) && p.due && p.due <= today)
    .sort((a, b) => a[1].due.localeCompare(b[1].due))
    .map(([id]) => id).filter(wordById);
}

function completedToday(id) { return state.sessions[localDay()]?.completed?.includes(id); }
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(name).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderDashboard() {
  const today = new Date();
  $("todayLabel").textContent = today.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }).toUpperCase();
  const plan = getTodayPlan();
  const completed = plan.filter(completedToday).length;
  $("newCount").textContent = completed ? `${completed}/15` : "15";
  $("dueCount").textContent = dueIds().length;
  const mastered = Object.values(state.progress).filter(p => p.stability >= 21 && p.reps >= 3).length;
  $("masteredMetric").textContent = mastered;
  $("streakMetric").textContent = calculateStreak();
  $("retentionMetric").textContent = estimatedRetention();
  $("startButton").querySelector("span").textContent = completed === 15 ? "今日完成 · 自由复习" : completed ? "继续今日训练" : "开始今日训练";
  $("soundToggle").textContent = state.sound ? "◖" : "×";
}

function calculateStreak() {
  let count = 0;
  const date = new Date();
  while (true) {
    const day = localDay(date);
    if (state.sessions[day]?.completed?.length) { count++; date.setDate(date.getDate() - 1); }
    else if (count === 0) { date.setDate(date.getDate() - 1); if (!state.sessions[localDay(date)]?.completed?.length) break; }
    else break;
  }
  return count;
}

function estimatedRetention() {
  const cards = Object.values(state.progress).filter(p => p.last && p.stability);
  if (!cards.length) return "—";
  const todayN = dayNumber(localDay());
  const mean = cards.reduce((sum, p) => {
    const elapsed = Math.max(0, todayN - dayNumber(p.last));
    return sum + Math.exp(-elapsed / Math.max(.25, p.stability));
  }, 0) / cards.length;
  return `${Math.round(mean * 100)}%`;
}

function startSession() {
  const plan = getTodayPlan();
  const remaining = plan.filter(id => !completedToday(id));
  const newIds = remaining.length ? remaining : plan;
  queue = [...newIds.map(id => ({ id, phase: remaining.length ? "new" : "practice" })), ...dueIds().map(id => ({ id, phase: "review" }))];
  currentIndex = 0;
  sessionRatings = { easy: 0, good: 0, hard: 0, again: 0 };
  showView("study");
  renderCard();
}

function exerciseFor(word) {
  const reps = state.progress[word.id]?.reps || 0;
  if (!reps) return "meaning";
  return ["production", "cloze", "application", "meaning"][(reps - 1) % 4];
}
function highlightedCloze(example, term) {
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replaced = example.replace(new RegExp(safe, "i"), "__________");
  return replaced === example ? `${example}<br><br><strong>请用 ${term} 改写或复述这句话。</strong>` : replaced;
}

function renderCard() {
  if (currentIndex >= queue.length) return finishSession();
  const item = queue[currentIndex];
  currentWord = wordById(item.id);
  if (!currentWord) { currentIndex++; return renderCard(); }
  const ex = exerciseFor(currentWord);
  $("answerArea").classList.add("hidden");
  $("ratingPanel").classList.add("hidden");
  $("revealButton").classList.remove("hidden");
  $("phaseLabel").textContent = item.phase === "new" ? "今日新词" : item.phase === "review" ? "到期复习" : "自由复习";
  $("progressText").textContent = `${currentIndex + 1} / ${queue.length}`;
  $("progressBar").style.width = `${(currentIndex / queue.length) * 100}%`;
  $("sessionScore").textContent = `${sessionRatings.easy} 熟练`;
  $("wordCategory").textContent = currentWord.type === "research" ? "研究术语" : "生活词汇";
  const labels = { meaning: "基础词义", production: "中译英", cloze: "语境填空", application: "主动造句" };
  $("exerciseType").textContent = labels[ex];

  if (ex === "meaning") {
    const prompt = (currentWord.components || []).length > 1 ? "先说出其中每个单词的常见意思，再尝试理解整个词组。" : "先说出它在普通英语中最常见的意思。";
    $("promptArea").innerHTML = `<div class="word-main"><h2>${currentWord.term}</h2><span class="phonetic">${currentWord.phonetic}</span><button class="sound-button" aria-label="播放发音">◖</button></div><p class="question-label">${prompt}</p>`;
  } else if (ex === "production") {
    $("promptArea").innerHTML = `<p class="cue"><strong>${currentWord.chinese}</strong></p><p class="question-label">请回忆英文术语，最好完整说出或写出。</p>`;
  } else if (ex === "cloze") {
    $("promptArea").innerHTML = `<p class="cue">${highlightedCloze(currentWord.example, currentWord.term)}</p><p class="question-label">请填入最恰当的英文词或词组。</p>`;
  } else {
    $("promptArea").innerHTML = `<p class="cue">请用 <strong>${currentWord.term}</strong><br>说一句自然、简单的英语。</p><p class="question-label">先表达日常含义；熟悉之后再进入专业语境。</p>`;
  }
  const parts = (currentWord.components || [{ word: currentWord.term, meaning: currentWord.chinese }])
    .map(p => `<div class="word-part"><strong>${escapeHtml(p.word)}</strong><span>${escapeHtml(p.meaning)}</span></div>`).join("");
  const partLabel = partOfSpeech(currentWord);
  const exampleZh = currentWord.exampleZh || state.exampleTranslations?.[currentWord.id] || "正在获取中文翻译…";
  $("answerArea").innerHTML = `<div class="answer-title"><strong>${escapeHtml(currentWord.term)}</strong><span>${escapeHtml(currentWord.phonetic)} · ${escapeHtml(currentWord.chinese)}</span><button class="sound-button" aria-label="播放发音">◖</button></div>
    <section class="learning-section basic-meaning"><small>第一步 · 普通英语中的作用</small><p><b>${partLabel}</b>　${escapeHtml(currentWord.normalMeaning || currentWord.chinese)}</p></section>
    ${(currentWord.components || []).length > 1 ? `<section class="learning-section"><small>第二步 · 逐词拆解</small><div class="word-parts">${parts}</div></section>` : ""}
    <section class="learning-section"><small>${(currentWord.components || []).length > 1 ? "第三步" : "第二步"} · 完整含义</small><p class="definition">${escapeHtml(currentWord.definition)}</p></section>
    <section class="example-block"><small>例句</small><p class="example-en">${escapeHtml(currentWord.example)}</p><p class="example-zh" id="exampleTranslation">${escapeHtml(exampleZh)}</p><p class="example-note"><strong>这里怎么用：</strong>${escapeHtml(exampleUsage(currentWord, partLabel))}</p></section>`;
  document.querySelectorAll(".sound-button").forEach(b => b.addEventListener("click", () => speak(currentWord.term)));
  ensureExampleTranslation(currentWord);
}

function partOfSpeech(word) {
  const adjectives = new Set(["pre-reflective", "coherent", "concise", "relevant", "feasible", "tentative", "compelling", "ambiguous", "substantial"]);
  const verbs = new Set(["articulate", "clarify", "elaborate", "prioritise", "overlook", "convey", "retain", "encounter", "distinguish", "revise", "account for", "draw on", "point out", "work through", "follow up", "engage with", "make sense of", "come across"]);
  if (adjectives.has(word.term)) return "形容词";
  if (verbs.has(word.term)) return word.term.includes(" ") ? "动词短语" : "动词";
  return word.term.includes(" ") || word.term.includes("-") ? "名词性术语" : "名词";
}

function exampleUsage(word, label) {
  if ((word.components || []).length > 1) return `“${word.term}”在句中作为一个完整的${label}使用，整体表示“${word.chinese}”，不要逐字硬译。`;
  return `“${word.term}”在句中作${label}，核心意思是“${word.chinese}”。先掌握这个常见作用，再记更精确的专业含义。`;
}

async function ensureExampleTranslation(word) {
  if (!word?.example || word.exampleZh || state.exampleTranslations?.[word.id] || !/[a-z]/i.test(word.example)) return;
  try {
    const result = await fetchJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word.example)}&langpair=en|zh-CN`);
    const translated = result?.responseData?.translatedText;
    if (!translated) throw new Error("no translation");
    state.exampleTranslations ||= {};
    state.exampleTranslations[word.id] = translated;
    saveState();
    if (currentWord?.id === word.id) {
      const el = $("exampleTranslation");
      if (el) el.textContent = translated;
    }
  } catch {
    if (currentWord?.id === word.id) {
      const el = $("exampleTranslation");
      if (el) el.textContent = "暂时无法联网获取翻译；稍后重新打开本卡会自动重试。";
    }
  }
}

function reveal() {
  $("answerArea").classList.remove("hidden");
  $("ratingPanel").classList.remove("hidden");
  $("revealButton").classList.add("hidden");
  if (state.sound) speak(currentWord.term);
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-GB";
  utterance.rate = .82;
  speechSynthesis.speak(utterance);
}

function selectedEnglishWord() {
  const selected = window.getSelection()?.toString().trim() || "";
  const match = selected.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/);
  return match?.[0]?.replace(/[’']s$/i, "") || "";
}

function localWordHelp(word) {
  const lower = word.toLowerCase();
  const exact = allWords().find(item => item.term.toLowerCase() === lower);
  if (exact) return {
    word,
    phonetic: exact.phonetic,
    part: partOfSpeech(exact),
    translation: exact.chinese,
    definition: exact.normalMeaning || exact.definition
  };
  for (const item of allWords()) {
    const component = item.components?.find(part => part.word.toLowerCase() === lower && !part.meaning.startsWith("这是术语"));
    if (component) return { word, phonetic: "", part: "基础词义", translation: component.meaning, definition: `这是词组“${item.term}”中的一个构成词。` };
  }
  return null;
}

function ensureQuickPopover() {
  let popover = $("quickWordPopover");
  if (popover) return popover;
  popover = document.createElement("aside");
  popover.id = "quickWordPopover";
  popover.className = "quick-word-popover hidden";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "单词简释");
  popover.innerHTML = `<button class="quick-close" aria-label="关闭简释">×</button><div id="quickWordBody"></div>`;
  document.body.appendChild(popover);
  popover.querySelector(".quick-close").addEventListener("click", closeQuickPopover);
  return popover;
}

function positionQuickPopover(popover, x, y) {
  popover.classList.remove("hidden");
  const margin = 12;
  const width = Math.min(340, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;
  const left = Math.min(Math.max(margin, x + 12), window.innerWidth - width - margin);
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, y + 16)}px`;
  requestAnimationFrame(() => {
    const rect = popover.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - margin) popover.style.top = `${Math.max(margin, y - rect.height - 14)}px`;
  });
}

function renderQuickWord(result, status = "ready") {
  const body = $("quickWordBody");
  if (!body) return;
  if (status === "loading") {
    body.innerHTML = `<div class="quick-loading"><span></span>正在查询 <strong>${escapeHtml(result.word)}</strong>…</div>`;
    return;
  }
  if (status === "error") {
    body.innerHTML = `<h3>${escapeHtml(result.word)}</h3><p class="quick-error">暂时没有查到这个词。请检查网络，或使用顶部“查词 · 翻译”进行完整查询。</p>`;
    return;
  }
  body.innerHTML = `<div class="quick-head"><div><h3>${escapeHtml(result.word)}</h3>${result.phonetic ? `<span>${escapeHtml(result.phonetic)}</span>` : ""}</div><button class="quick-sound" aria-label="播放发音">◖</button></div><div class="quick-translation">${escapeHtml(result.translation || "暂无中文翻译")}</div><small>${escapeHtml(result.part || "基础释义")}</small><p>${escapeHtml(result.definition || "暂无简明解释")}</p>`;
  body.querySelector(".quick-sound").addEventListener("click", () => speak(result.word));
}

async function openQuickWord(word, x, y) {
  const popover = ensureQuickPopover();
  positionQuickPopover(popover, x, y);
  const local = localWordHelp(word);
  if (local) return renderQuickWord(local);
  const cacheKey = word.toLowerCase();
  if (state.quickLookups?.[cacheKey]) return renderQuickWord(state.quickLookups[cacheKey]);
  renderQuickWord({ word }, "loading");
  try {
    const [dictResult, translationResult] = await Promise.allSettled([
      fetchJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(cacheKey)}`),
      fetchJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|zh-CN`)
    ]);
    const dict = dictResult.status === "fulfilled" ? dictResult.value : {};
    const english = Array.isArray(dict.en) ? dict.en : [];
    const entry = english.find(item => item.definitions?.length) || english[0];
    const first = entry?.definitions?.[0];
    const result = {
      word,
      phonetic: "",
      part: entry?.partOfSpeech || "基础释义",
      translation: translationResult.status === "fulfilled" ? translationResult.value?.responseData?.translatedText || "" : "",
      definition: stripMarkup(first?.definition || "")
    };
    if (!result.translation && !result.definition) throw new Error("not found");
    state.quickLookups ||= {};
    state.quickLookups[cacheKey] = result;
    saveState();
    if (!popover.classList.contains("hidden") && $("quickWordBody")?.textContent.includes(word)) renderQuickWord(result);
  } catch {
    renderQuickWord({ word }, "error");
  }
}

function closeQuickPopover() {
  $("quickWordPopover")?.classList.add("hidden");
}

function recordRating(word, rating) {
  const today = localDay();
  const old = state.progress[word.id] || { reps: 0, stability: .4, difficulty: 5 };
  let stability = old.stability;
  let interval = 1;
  if (rating === "again") { stability = Math.max(.25, stability * .55); interval = 0; }
  if (rating === "hard") { stability = Math.max(1, stability * 1.35); interval = 1; }
  if (rating === "good") { stability = Math.max(1.2, stability * 2.6); interval = stability; }
  if (rating === "easy") { stability = Math.max(3, stability * 4.2); interval = stability; }
  state.progress[word.id] = {
    reps: old.reps + 1,
    stability: Number(stability.toFixed(2)),
    difficulty: Math.min(10, Math.max(1, old.difficulty + ({ again: 1, hard: .4, good: -.2, easy: -.7 }[rating]))),
    last: today,
    due: addDays(today, interval),
    lastRating: rating
  };
  const session = state.sessions[today] || { completed: [], ratings: {} };
  if (rating !== "again" && !session.completed.includes(word.id)) session.completed.push(word.id);
  session.ratings[word.id] = rating;
  state.sessions[today] = session;
  saveState();
  return state.progress[word.id];
}

function rate(rating) {
  recordRating(currentWord, rating);
  sessionRatings[rating]++;
  if (rating === "again") queue.splice(Math.min(queue.length, currentIndex + 5), 0, { id: currentWord.id, phase: "review" });
  currentIndex++;
  renderCard();
}

function finishSession() {
  $("summaryDone").textContent = queue.length;
  $("summaryEasy").textContent = sessionRatings.easy;
  $("summaryGood").textContent = sessionRatings.good;
  $("summaryWeak").textContent = sessionRatings.hard + sessionRatings.again;
  showView("summary");
}

function renderLibrary() {
  const words = allWords();
  const learned = words.filter(w => state.progress[w.id]).length;
  const research = words.filter(w => w.type === "research").length;
  const life = words.filter(w => w.type === "life").length;
  $("libraryStats").innerHTML = `<span><strong>${words.length}</strong> 总词数</span><span><strong>${research}</strong> 研究术语</span><span><strong>${life}</strong> 生活词汇</span><span><strong>${learned}</strong> 已学习</span>`;
  $("wordList").innerHTML = words.map(w => {
    const p = state.progress[w.id];
    return `<div class="mix-row"><span><i class="${w.type === "research" ? "research-dot" : "life-dot"}"></i><strong>${w.term}</strong> · ${w.chinese}</span><b>${p ? (p.stability >= 21 ? "已掌握" : `复习 ${p.due}`) : "未学习"}</b></div>`;
  }).join("");
}

function exportData() {
  const payload = { exportedAt: new Date().toISOString(), library: allWords(), learningState: state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `lexis-field-${localDay()}.json`; a.click();
  URL.revokeObjectURL(url);
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      const words = Array.isArray(incoming) ? incoming : incoming.library;
      if (!Array.isArray(words)) throw new Error("文件中没有词库数组");
      const baseKeys = new Set(window.WORD_LIBRARY.map(w => `${w.type}:${w.term.toLowerCase()}`));
      const customByKey = new Map((state.customWords || []).map(w => [`${w.type}:${w.term.toLowerCase()}`, w]));
      let added = 0;
      let updated = 0;
      words.filter(w => w.term && w.chinese).forEach((w, i) => {
        const type = w.type === "life" ? "life" : "research";
        const key = `${type}:${w.term.toLowerCase()}`;
        if (baseKeys.has(key)) return;
        const old = customByKey.get(key);
        const normalized = {
          id: old?.id || w.id || `custom-${Date.now()}-${i}`,
          type, phonetic: "", definition: "", example: "", application: "", ...old, ...w, type
        };
        customByKey.set(key, normalized);
        old ? updated++ : added++;
      });
      state.customWords = [...customByKey.values()];
      saveState(); renderLibrary(); renderDashboard();
      alert(`词包更新完成：新增 ${added} 个，更新 ${updated} 个；原有学习进度已保留。`);
    } catch (e) { alert(`导入失败：${e.message}`); }
  };
  reader.readAsText(file);
}

let lookupCurrent = null;
let practiceState = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
function decodeEntities(value = "") {
  const box = document.createElement("textarea");
  box.innerHTML = value;
  return box.value;
}
function stripMarkup(value = "") {
  const box = document.createElement("div");
  box.innerHTML = value;
  return box.textContent || "";
}
function setNetworkState(kind, text) {
  $("networkDot").className = kind;
  $("networkStatus").textContent = text;
}
async function fetchJson(url, timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function lookupText(raw) {
  const query = raw.trim();
  if (!query) return;
  const cacheKey = query.toLocaleLowerCase();
  state.searchCache ||= {};
  const localMatch = allWords().find(w => w.term.toLocaleLowerCase() === cacheKey || w.chinese === query);
  $("searchResult").className = "search-result empty-result";
  $("searchResult").textContent = "正在查询词典与翻译……";
  setNetworkState("", "正在联网");
  const hasChinese = /[\u3400-\u9fff]/.test(query);
  const source = hasChinese ? "zh-CN" : "en";
  const target = hasChinese ? "en" : "zh-CN";
  const dictionaryRequest = !hasChinese && /^[A-Za-z][A-Za-z '-]*$/.test(query)
    ? fetchJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(query)}`)
    : Promise.reject(new Error("skip dictionary"));
  const translationRequest = fetchJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=${source}%7C${target}`);
  const [dictionary, translation] = await Promise.allSettled([dictionaryRequest, translationRequest]);

  const cached = state.searchCache[cacheKey];
  if (dictionary.status === "rejected" && translation.status === "rejected" && (cached || localMatch)) {
    const fallback = cached || {
      query, term: localMatch.term, translation: localMatch.chinese, phonetic: localMatch.phonetic,
      audio: "", meanings: [{ part: localMatch.category, definition: localMatch.definition, example: localMatch.example }], example: localMatch.example
    };
    lookupCurrent = fallback;
    setNetworkState("offline", "网络不可用 · 已显示本地词库");
    return renderLookup(fallback);
  }
  if (dictionary.status === "rejected" && translation.status === "rejected") {
    setNetworkState("offline", "连接失败");
    $("searchResult").className = "search-result error-result";
    $("searchResult").innerHTML = "暂时无法连接查询服务。请确认电脑已经联网后重试；每日学习和专项练习不受影响。";
    return;
  }

  const dictEntries = dictionary.status === "fulfilled" ? (dictionary.value?.en || []) : [];
  let meanings = dictEntries.flatMap(entry => (entry.definitions || []).slice(0, 2).map(d => ({
    part: entry.partOfSpeech || "definition",
    definition: stripMarkup(d.definition || ""),
    example: stripMarkup(d.parsedExamples?.[0]?.example || d.examples?.[0] || "")
  }))).slice(0, 4);
  if (localMatch) meanings = [{ part: localMatch.category, definition: localMatch.definition, example: localMatch.example }, ...meanings].slice(0, 4);
  const phonetic = localMatch?.phonetic || "";
  const audio = "";
  const translated = translation.status === "fulfilled" ? decodeEntities(translation.value?.responseData?.translatedText || "") : "";
  const result = {
    query,
    term: hasChinese ? translated : (localMatch?.term || query),
    translation: hasChinese ? query : (translated || localMatch?.chinese || ""),
    phonetic, audio, meanings,
    example: meanings.find(m => m.example)?.example || ""
  };
  lookupCurrent = result;
  state.searchCache[cacheKey] = result;
  const keys = Object.keys(state.searchCache);
  if (keys.length > 50) delete state.searchCache[keys[0]];
  saveState();
  setNetworkState("online", dictionary.status === "fulfilled" && translation.status === "fulfilled" ? "查询成功" : "部分服务可用");
  renderLookup(result);
}
function renderLookup(result) {
  const definitions = result.meanings.length
    ? `<div class="definition-list">${result.meanings.map(m => `<div class="definition-item"><small>${escapeHtml(m.part)}</small>${escapeHtml(m.definition)}${m.example ? `<div class="lookup-example">${escapeHtml(m.example)}</div>` : ""}</div>`).join("")}</div>`
    : `<div class="definition-item">当前没有返回英文词典释义，但翻译结果仍可加入词库。</div>`;
  $("searchResult").className = "search-result";
  $("searchResult").innerHTML = `<div class="lookup-head"><h3>${escapeHtml(result.term || result.query)}</h3>${result.phonetic ? `<span class="phonetic">${escapeHtml(result.phonetic)}</span>` : ""}<button class="sound-button" id="lookupSound" aria-label="播放发音">◖</button></div><div class="lookup-translation">${escapeHtml(result.translation || "暂时没有翻译结果")}</div>${definitions}<div class="lookup-actions"><button class="secondary-button" data-add-lookup="research">＋ 加入研究词库</button><button class="secondary-button" data-add-lookup="life">＋ 加入生活词库</button></div>`;
  $("lookupSound").addEventListener("click", () => {
    if (result.audio) new Audio(result.audio).play().catch(() => speak(result.term)); else speak(result.term);
  });
  document.querySelectorAll("[data-add-lookup]").forEach(button => button.addEventListener("click", () => addLookupToLibrary(button.dataset.addLookup)));
}
function addLookupToLibrary(type) {
  if (!lookupCurrent?.term) return;
  const key = `${type}:${lookupCurrent.term.toLowerCase()}`;
  if (allWords().some(w => `${w.type}:${w.term.toLowerCase()}` === key)) return alert("这个词已经在对应词库中了。");
  state.customWords ||= [];
  state.customWords.push({
    id: `custom-${Date.now()}`, type, category: type === "research" ? "研究术语" : "生活词汇",
    term: lookupCurrent.term, phonetic: lookupCurrent.phonetic || "", chinese: lookupCurrent.translation || "",
    definition: lookupCurrent.meanings[0]?.definition || lookupCurrent.translation || "待补充释义",
    example: lookupCurrent.example || `I am learning how to use ${lookupCurrent.term} in context.`,
    application: type === "research" ? "请在研究写作或导师讨论中尝试使用这个词。" : "请在英国生活的真实交流中尝试使用这个词。"
  });
  saveState();
  alert(`“${lookupCurrent.term}”已加入${type === "research" ? "研究" : "生活"}词库。`);
}

function openPractice() {
  $("practiceSetup").classList.remove("hidden");
  $("practiceRunner").classList.add("hidden");
  $("practiceDialog").showModal();
}
function practicePool() {
  const learned = allWords().filter(w => state.progress[w.id]);
  const today = getTodayPlan().map(wordById).filter(Boolean);
  const pool = learned.length >= 4 ? learned : [...new Map([...today, ...allWords()].map(w => [w.id, w])).values()];
  return seededShuffle(pool, `${Date.now()}`);
}
function startPractice(mode) {
  const pool = practicePool();
  practiceState = { mode, words: pool.slice(0, Math.min(10, pool.length)), index: 0, score: 0, pool };
  $("practiceSetup").classList.add("hidden");
  $("practiceRunner").classList.remove("hidden");
  $("practiceProgress").parentElement.classList.remove("hidden");
  $("practiceQuestion").classList.remove("hidden");
  $("practiceAnswers").classList.remove("hidden");
  $("practiceFeedback").classList.add("hidden");
  $("nextPractice").classList.add("hidden");
  $("practiceFinish").classList.add("hidden");
  renderPracticeQuestion();
}
function renderPracticeQuestion() {
  const p = practiceState;
  if (p.index >= p.words.length) {
    $("practiceProgress").parentElement.classList.add("hidden");
    $("practiceQuestion").classList.add("hidden");
    $("practiceAnswers").classList.add("hidden");
    $("practiceFeedback").classList.add("hidden");
    $("nextPractice").classList.add("hidden");
    $("practiceFinalScore").textContent = `${p.score}/${p.words.length}`;
    $("practiceFinish").classList.remove("hidden");
    return;
  }
  const word = p.words[p.index];
  $("practiceProgress").textContent = `${p.index + 1} / ${p.words.length}`;
  $("practiceScore").textContent = `答对 ${p.score}`;
  $("practiceFeedback").className = "practice-feedback hidden";
  $("nextPractice").classList.add("hidden");
  if (p.mode === "choice") {
    $("practiceQuestion").innerHTML = `<span class="practice-word-line"><span>${escapeHtml(word.term)}</span><button class="sound-button practice-sound-button" id="practiceWordSound" type="button" aria-label="播放 ${escapeHtml(word.term)} 的发音">◖</button></span><span class="phonetic practice-instruction">请选择最准确的中文含义</span>`;
    $("practiceWordSound").addEventListener("click", () => speak(word.term));
    const wrong = seededShuffle(p.pool.filter(w => w.id !== word.id), `${word.id}-${p.index}`).slice(0, 3).map(w => w.chinese);
    const options = seededShuffle([word.chinese, ...wrong], `${p.index}-${word.id}`);
    $("practiceAnswers").innerHTML = `<div class="practice-options">${options.map(o => `<button data-answer="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join("")}</div>`;
    document.querySelectorAll("[data-answer]").forEach(b => b.addEventListener("click", () => gradePractice(b.dataset.answer === word.chinese, word, b)));
  } else {
    const cue = p.mode === "cloze" ? highlightedCloze(escapeHtml(word.example), word.term) : `<strong>${escapeHtml(word.chinese)}</strong><br><span class="phonetic">请写出对应的英文</span>`;
    $("practiceQuestion").innerHTML = cue;
    $("practiceAnswers").innerHTML = `<form class="practice-input" id="practiceInputForm"><input id="practiceInput" autocomplete="off" placeholder="输入英文答案"><button>确认</button></form>`;
    $("practiceInputForm").addEventListener("submit", e => { e.preventDefault(); const answer = $("practiceInput").value.trim().toLowerCase(); gradePractice(answer === word.term.toLowerCase(), word, $("practiceInput")); });
    $("practiceInput").focus();
  }
}
function gradePractice(correct, word, control) {
  if (!$("nextPractice").classList.contains("hidden")) return;
  if (correct) practiceState.score++;
  if (control?.classList) control.classList.add(correct ? "correct" : "wrong");
  $("practiceFeedback").className = `practice-feedback${correct ? "" : " wrong"}`;
  const result = correct ? `正确：<strong>${escapeHtml(word.term)}</strong>` : `正确答案是 <strong>${escapeHtml(word.term)}</strong> · ${escapeHtml(word.chinese)}`;
  $("practiceFeedback").innerHTML = `<span>${result}</span><button class="sound-button practice-feedback-sound" type="button" aria-label="播放 ${escapeHtml(word.term)} 的发音">◖</button>`;
  $("practiceFeedback").querySelector(".practice-feedback-sound").addEventListener("click", () => speak(word.term));
  $("nextPractice").classList.remove("hidden");
}
function nextPracticeQuestion() { practiceState.index++; renderPracticeQuestion(); }

$("startButton").addEventListener("click", startSession);
$("revealButton").addEventListener("click", reveal);
$("exitStudy").addEventListener("click", () => { renderDashboard(); showView("dashboard"); });
$("finishButton").addEventListener("click", () => { renderDashboard(); showView("dashboard"); });
$("ratingPanel").addEventListener("click", e => { const b = e.target.closest("button[data-rating]"); if (b) rate(b.dataset.rating); });
$("soundToggle").addEventListener("click", () => { state.sound = !state.sound; saveState(); renderDashboard(); });
$("libraryButton").addEventListener("click", () => { renderLibrary(); $("libraryDialog").showModal(); });
$("closeLibrary").addEventListener("click", () => $("libraryDialog").close());
$("searchButton").addEventListener("click", () => { $("searchDialog").showModal(); setTimeout(() => $("searchInput").focus(), 50); });
$("closeSearch").addEventListener("click", () => $("searchDialog").close());
$("searchForm").addEventListener("submit", e => { e.preventDefault(); lookupText($("searchInput").value); });
$("practiceButton").addEventListener("click", openPractice);
$("closePractice").addEventListener("click", () => $("practiceDialog").close());
$("practiceSetup").addEventListener("click", e => { const b = e.target.closest("button[data-mode]"); if (b) startPractice(b.dataset.mode); });
$("nextPractice").addEventListener("click", nextPracticeQuestion);
$("practiceAgain").addEventListener("click", () => {
  $("practiceRunner").classList.add("hidden");
  $("practiceFinish").classList.add("hidden");
  $("practiceSetup").classList.remove("hidden");
});
$("exportButton").addEventListener("click", exportData);
$("importFile").addEventListener("change", e => e.target.files[0] && importData(e.target.files[0]));
$("resetButton").addEventListener("click", () => {
  if (confirm("确定清除全部学习记录吗？内置词库不会被删除。")) { state = { ...defaultState, customWords: state.customWords }; saveState(); renderLibrary(); renderDashboard(); }
});
document.addEventListener("dblclick", event => {
  if (event.target.closest?.("#quickWordPopover")) return;
  const word = selectedEnglishWord();
  if (word) openQuickWord(word, event.clientX, event.clientY);
});
document.addEventListener("pointerdown", event => {
  const popover = $("quickWordPopover");
  if (popover && !popover.classList.contains("hidden") && !event.target.closest?.("#quickWordPopover")) closeQuickPopover();
});
window.addEventListener("scroll", closeQuickPopover, true);
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeQuickPopover();
  if (!$("study").classList.contains("active")) return;
  if (e.code === "Space" && !$("revealButton").classList.contains("hidden")) { e.preventDefault(); reveal(); }
  const map = { "1": "again", "2": "hard", "3": "good", "4": "easy" };
  if (map[e.key] && !$("ratingPanel").classList.contains("hidden")) rate(map[e.key]);
});

renderDashboard();

// Expose the same daily-plan and review actions to compatible assistant browsers.
function registerModelTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const safeRegister = tool => {
    try { Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch {}
  };
  safeRegister({
    name: "read_daily_vocabulary_plan",
    title: "读取今日词汇计划",
    description: "读取今天固定的10个研究术语、5个生活词汇及到期复习数量，不改变学习记录。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      const plan = getTodayPlan().map(wordById).filter(Boolean);
      return { date: localDay(), research: plan.filter(w => w.type === "research"), life: plan.filter(w => w.type === "life"), dueReviewCount: dueIds().length };
    }
  });
  safeRegister({
    name: "record_vocabulary_review",
    title: "记录一次词汇复习",
    description: "按忘记、困难、记得或熟练记录一个词的复习结果，并更新其下次复习日期。",
    inputSchema: {
      type: "object",
      properties: { wordId: { type: "string" }, rating: { type: "string", enum: ["again", "hard", "good", "easy"] } },
      required: ["wordId", "rating"], additionalProperties: false
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      const word = wordById(input?.wordId);
      if (!word || !["again", "hard", "good", "easy"].includes(input?.rating)) throw new Error("无效的词汇或评分");
      const progress = recordRating(word, input.rating);
      renderDashboard();
      return { wordId: word.id, rating: input.rating, nextReview: progress.due };
    }
  });
}
registerModelTools();
