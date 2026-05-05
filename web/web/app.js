// ========== 路由 & 页面管理 ==========
const pages = ['home', 'list', 'practice', 'assessment', 'wrong', 'profile']

function showPage(name) {
  pages.forEach(p => {
    const el = document.getElementById('page-' + p)
    if (el) el.classList.toggle('active', p === name)
  })
  document.querySelectorAll('.tab-item').forEach(t => {
    t.classList.toggle('active', t.dataset.page === name)
  })
  window.scrollTo(0, 0)
  if (name === 'home') refreshHome()
  if (name === 'list') renderList()
  if (name === 'wrong') renderWrongBook()
  if (name === 'profile') refreshProfile()
}

// ========== Supabase 在线状态 ==========
let isOnline = false

async function detectOnline() {
  if (typeof supabase !== 'undefined' && initSupabase()) {
    const userId = await ensureUser()
    if (userId) {
      isOnline = true
      console.log('Supabase 已连接')
      const res = await fetchQuestions({ page: 1, pageSize: 200 })
      if (res && res.data && res.data.length > 0) {
        window.QUESTIONS = res.data.map(q => ({
          ...q,
          tags: typeof q.tags === 'string' ? JSON.parse(q.tags) : q.tags,
          options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options
        }))
      }
    }
  }
  if (!isOnline) {
    console.log('离线模式：使用本地数据')
  }
  return isOnline
}

// ========== 数据存储（本地 + 远程双写）==========
function getRecords() {
  return JSON.parse(localStorage.getItem('sql_records') || '[]')
}

async function saveRecord(record) {
  const records = getRecords()
  records.push(record)
  localStorage.setItem('sql_records', JSON.stringify(records))
  if (!record.isCorrect) {
    const wrongBook = getWrongBook()
    if (!wrongBook.find(w => w.questionId === record.questionId)) {
      wrongBook.push({ questionId: record.questionId, reviewed: false })
      localStorage.setItem('sql_wrong_book', JSON.stringify(wrongBook))
    }
  } else {
    const wrongBook = getWrongBook()
    const idx = wrongBook.findIndex(w => w.questionId === record.questionId)
    if (idx !== -1) wrongBook.splice(idx, 1)
    localStorage.setItem('sql_wrong_book', JSON.stringify(wrongBook))
  }

  // 智能推题权重更新
  updateAfterAnswer(record.questionId, record.isCorrect)

  if (isOnline) {
    submitAnswerRemote(record.questionId, record.chosenOption, record.isCorrect).catch(e =>
      console.error('远程同步失败:', e)
    )
  }
}

function getWrongBook() {
  return JSON.parse(localStorage.getItem('sql_wrong_book') || '[]')
}

function removeWrongItem(questionId) {
  const wrongBook = getWrongBook().filter(w => w.questionId !== questionId)
  localStorage.setItem('sql_wrong_book', JSON.stringify(wrongBook))
  if (isOnline) {
    removeFromWrongBookRemote(questionId).catch(e => console.error('远程删除错题失败:', e))
  }
}

function getStats() {
  const records = getRecords()
  const total = records.length
  const correct = records.filter(r => r.isCorrect).length
  const today = new Date().toDateString()
  const todayCount = records.filter(r => new Date(r.time).toDateString() === today).length
  return {
    total,
    correct,
    accuracy: total > 0 ? Math.round(correct / total * 100) : 0,
    todayCount,
    wrongCount: getWrongBook().filter(w => !w.reviewed).length
  }
}

// ========== SQL 格式化 ==========
const SQL_KEYWORDS = /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|BETWEEN|LIKE|IS|NULL|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|AS|ON|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|SELF\s+JOIN|UNION|ALL|EXCEPT|INTERSECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|SET|VALUES|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|DISTINCT|CASE|WHEN|THEN|ELSE|END|EXISTS|ASC|DESC|WITH|RECURSIVE|OVER|PARTITION\s+BY|ROW_NUMBER|RANK|DENSE_RANK|LAG|LEAD|SUM|COUNT|AVG|MIN|MAX|COALESCE|IFNULL|CAST|CONCAT|SUBSTRING|TRIM|UPPER|LOWER|LENGTH|ROUND|FETCH|NEXT|ROWS|ONLY|PRIMARY\s+KEY|FOREIGN\s+KEY|REFERENCES|UNIQUE|CHECK|DEFAULT|CONSTRAINT|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK)\b/gi

function highlightSQL(text) {
  return text.replace(SQL_KEYWORDS, '<span class="sql-kw">$1</span>')
}

function formatLongSQL(sql) {
  const breakPoints = [
    /\b(LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|JOIN)\b/gi,
    /\b(WHERE)\b/gi,
    /\b(AND|OR)\b/gi,
    /\b(GROUP\s+BY)\b/gi,
    /\b(HAVING)\b/gi,
    /\b(ORDER\s+BY)\b/gi,
    /\b(LIMIT|OFFSET)\b/gi,
    /\b(UNION|EXCEPT|INTERSECT)\b/gi,
    /\b(ON)\b/gi,
    /\b(SET)\b/gi,
    /\b(VALUES)\b/gi,
    /\b(FROM)\b/gi
  ]

  let parts = [sql]
  for (const re of breakPoints) {
    const next = []
    for (const part of parts) {
      const match = part.search(re)
      if (match > 0) {
        next.push(part.slice(0, match))
        next.push(part.slice(match))
      } else {
        next.push(part)
      }
    }
    parts = next
  }

  if (parts.length <= 1) return null

  return parts.map((p, i) => {
    const indented = i > 0 ? '  ' + p.trim() : p.trim()
    return highlightSQL(indented)
  }).join('<br>')
}

function formatContent(text) {
  if (!text) return ''
  const lines = text.split('\n')
  return lines.map(line => {
    const isSQL = /^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(line.trim()) ||
      /\bSELECT\b.+\bFROM\b/i.test(line)
    if (!isSQL) return highlightSQL(line)
    // All SQL: format with line breaks by major clauses
    const formatted = formatLongSQL(line)
    if (formatted) return '<code class="sql-block">' + formatted + '</code>'
    return '<code class="sql-inline">' + highlightSQL(line) + '</code>'
  }).join('<br>')
}

// ========== 工具函数 ==========
const CATEGORIES = {
  basic: '基础查询',
  condition_date: '条件与日期',
  aggregate: '聚合函数',
  string_cast: '字符串与转换',
  result_set: '结果集操作',
  join: '多表连接',
  subquery: '子查询',
  window: '窗口函数',
  dml: '数据操作',
  analytics: '数据分析实战'
}
const DIFFICULTIES = { easy: '简单', medium: '中等', hard: '困难' }
const TYPE_ICONS = {
  basic: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  condition_date: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  aggregate: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>',
  string_cast: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>',
  result_set: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 6h-4v4M16 6h4v4M8 18H4v-4M16 18h4v-4"/></svg>',
  join: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>',
  subquery: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="5"/><path d="M15 15l4 4"/></svg>',
  window: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>',
  dml: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  analytics: '<svg style="width:16px;height:16px;vertical-align:-2px;margin-right:4px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 2 6-8"/></svg>'
}

function shuffleArray(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function diffTag(diff) {
  return `<span class="tag tag-${diff}">${DIFFICULTIES[diff]}</span>`
}

// ========== 首页（智能推题版）==========
function refreshHome() {
  const profile = getUserProfile()
  const homeEl = document.getElementById('home-content')
  const stats = getStats()

  // 未测评：显示欢迎+测评入口
  if (!profile || !profile.assessmentDone) {
    homeEl.innerHTML = renderWelcomePage()
    return
  }

  // 已测评：显示等级首页
  const promo = checkPromotionEligibility()
  const allMastered = isAllMastered(profile.boardWeights)

  homeEl.innerHTML = `
    ${renderLevelCard(profile, stats)}
    ${promo.eligible ? renderPromoEntry(profile, promo) : ''}
    ${allMastered ? renderCompleteCard() : ''}
    ${!promo.eligible && profile.level < 5 ? renderPromoProgress(promo, profile) : ''}
    <div class="card">
      <div class="section-title">题库分类</div>
      <div class="category-grid">
        ${renderCategoryGrid(profile)}
      </div>
    </div>
    ${renderBoardProgress(profile)}
    ${renderWeakSection(profile)}
  `
}

function renderWelcomePage() {
  return `
    <div class="hero-card">
      <div class="hero-bg"></div>
      <div class="hero-top">
        <div class="hero-left">
          <div class="hero-badge">NEW</div>
          <div class="hero-name">SQL 刷题</div>
          <div class="hero-desc">测测你的 SQL 水平，智能推题高效学习</div>
        </div>
        <div class="hero-icon-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
        </div>
      </div>
      <div class="hero-actions" style="margin-top:20px">
        <div class="hero-btn hero-btn-primary" onclick="startAssessment()">
          开始测评
        </div>
      </div>
      <div class="hero-skip" onclick="skipAssessment();showPage('home');refreshHome()">跳过，自由刷题 ›</div>
    </div>
    <div class="card">
      <div class="section-title">题库分类</div>
      <div class="category-grid">
        ${renderCategoryGrid(null)}
      </div>
    </div>
  `
}

function renderLevelCard(profile, stats) {
  const levelDef = getLevelDef(profile.level)
  const iconSvg = getLevelIcon(profile.level)
  const done = getDoneQuestions().length

  return `
    <div class="hero-card">
      <div class="hero-bg"></div>
      <div class="hero-top">
        <div class="hero-left">
          <div class="hero-badge">Lv.${profile.level}</div>
          <div class="hero-name">${levelDef.name}</div>
          <div class="hero-desc">${levelDef.desc}</div>
        </div>
        <div class="hero-icon-wrap">${iconSvg}</div>
      </div>
      <div class="hero-stats">
        <div class="hero-stat">
          <span class="hero-stat-val">${stats.total}</span>
          <span class="hero-stat-lbl">总答题</span>
        </div>
        <div class="hero-stat-divider"></div>
        <div class="hero-stat">
          <span class="hero-stat-val">${stats.accuracy}%</span>
          <span class="hero-stat-lbl">正确率</span>
        </div>
        <div class="hero-stat-divider"></div>
        <div class="hero-stat">
          <span class="hero-stat-val">${done}</span>
          <span class="hero-stat-lbl">已做</span>
        </div>
        <div class="hero-stat-divider"></div>
        <div class="hero-stat">
          <span class="hero-stat-val">${stats.todayCount}</span>
          <span class="hero-stat-lbl">今日</span>
        </div>
      </div>
      <div class="hero-actions">
        <div class="hero-btn hero-btn-primary" onclick="startSmartPractice()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
          智能刷题
        </div>
        <div class="hero-btn hero-btn-ghost" onclick="showRankPage()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
          报告
        </div>
      </div>
    </div>
  `
}

function renderPromoEntry(profile, promo) {
  const nextLevelDef = getLevelDef(promo.nextLevel)
  return `
    <div class="promo-card" onclick="startChallenge()">
      <div class="promo-icon">
        <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke-linejoin="round"/></svg>
      </div>
      <div class="promo-info">
        <div class="promo-title">晋阶挑战已解锁！</div>
        <div class="promo-desc">${profile.levelName} → ${nextLevelDef.name}</div>
      </div>
      <span class="promo-arrow">›</span>
    </div>
  `
}

function renderPromoProgress(promo, profile) {
  if (!promo.reasons || promo.reasons.length === 0) return ''
  return `
    <div class="card">
      <div class="section-title">晋阶进度</div>
      ${promo.reasons.map(r => `
        <div class="promo-progress-item">
          <span class="check ${r.met ? 'met' : 'unmet'}">${r.met ? '✓' : ''}</span>
          <span class="${r.met ? 'met' : 'unmet'}">${r.text}</span>
        </div>
      `).join('')}
    </div>
  `
}

const CATEGORY_SVGS = {
  basic: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  condition_date: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 2v4M8 2v4M3 10h18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  aggregate: '<svg viewBox="0 0 24 24"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>',
  string_cast: '<svg viewBox="0 0 24 24"><path d="M4 7V4h16v3M9 20h6M12 4v16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  result_set: '<svg viewBox="0 0 24 24"><path d="M8 6h-4v4M16 6h4v4M8 18H4v-4M16 18h4v-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  join: '<svg viewBox="0 0 24 24"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>',
  subquery: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="5"/><path d="M15 15l4 4"/></svg>',
  window: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>',
  dml: '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  analytics: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 16l4-4 4 2 6-8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
}

function renderCategoryGrid(profile) {
  return Object.entries(CATEGORIES).map(([key, name]) => `
    <div class="category-item" onclick="listFilter={difficulty:'',category:'${key}'};renderList();showPage('list')">
      <div class="category-icon">${CATEGORY_SVGS[key] || ''}</div>
      <span class="category-name">${name}</span>
    </div>
  `).join('')
}

function renderBoardProgress(profile) {
  if (!profile || !profile.boardWeights) return ''
  const records = getRecords()

  // 每题取最近一次答题结果（去重）
  const latestMap = new Map()
  for (let i = 0; i < records.length; i++) {
    latestMap.set(records[i].questionId, records[i])
  }

  return `
    <div class="card">
      <div class="section-title">学习进度</div>
      ${BOARD_ORDER.map(cat => {
        const entry = profile.boardWeights[cat]
        const catQuestions = QUESTIONS.filter(q => q.category === cat)
        const catTotal = catQuestions.length
        let catCorrect = 0
        catQuestions.forEach(q => {
          const latest = latestMap.get(q.id)
          if (latest && latest.isCorrect) catCorrect++
        })
        const catAcc = catTotal > 0 ? Math.round(catCorrect / catTotal * 100) : 0
        const barColor = catAcc >= 80 ? 'var(--success)' : catAcc >= 50 ? 'var(--warning)' : 'var(--danger)'
        const masteredTag = entry.mastered ? ' ✓' : ''
        return `
          <div class="board-progress-item">
            <span class="board-progress-name">${CATEGORIES[cat]}${masteredTag}</span>
            <div class="board-progress-bar">
              <div class="board-progress-fill" style="width:${catAcc}%;background:${barColor}"></div>
            </div>
            <span class="board-progress-count">${catCorrect}/${catTotal}</span>
          </div>
        `
      }).join('')}
    </div>
  `
}

function renderWeakSection(profile) {
  if (!profile || !profile.boardWeights) return ''
  const weakest = BOARD_ORDER
    .filter(cat => !profile.boardWeights[cat].mastered)
    .sort((a, b) => profile.boardWeights[b].weight - profile.boardWeights[a].weight)

  if (weakest.length === 0) return ''
  const weakCat = weakest[0]
  const weakName = CATEGORIES[weakCat]

  return `
    <div class="weak-banner">
      <span class="weak-label">薄弱板块：${weakName}</span>
      <span class="weak-action" onclick="listFilter={difficulty:'',category:'${weakCat}'};renderList();showPage('list')">去强化 ›</span>
    </div>
  `
}

function renderCompleteCard() {
  return `
    <div class="card complete-card">
      <div class="complete-icon">🏆</div>
      <div class="complete-title">恭喜通关！</div>
      <div class="complete-desc">所有板块已掌握，你是真正的SQL老炮！</div>
    </div>
  `
}

// ========== 智能刷题 ==========
let practiceSessionAnswers = []
function startSmartPractice() {
  const q = smartPickQuestion()
  if (!q) {
    startRandomPractice()
    return
  }

  practiceQuestions = [q]
  practiceIndex = 0
  practiceSelected = null
  practiceShowResult = false
  practiceSessionAnswers = []

  // 构建智能题组：连续推题
  const smartSet = []
  const usedIds = new Set([q.id])
  smartSet.push(q)
  for (let i = 0; i < 19; i++) {
    const next = smartPickQuestion()
    if (next && !usedIds.has(next.id)) {
      smartSet.push(next)
      usedIds.add(next.id)
    }
  }
  practiceQuestions = smartSet

  renderPractice()
  showPage('practice')
}

// ========== 题库列表 ==========
let listFilter = { difficulty: '', category: '' }
let searchKeyword = ''

function renderList() {
  document.querySelectorAll('.diff-chip').forEach(el => {
    el.classList.toggle('active', el.dataset.val === listFilter.difficulty)
  })
  document.querySelectorAll('.cat-chip').forEach(el => {
    el.classList.toggle('active', el.dataset.val === listFilter.category)
  })

  let filtered = QUESTIONS.filter(q => {
    if (listFilter.difficulty && q.difficulty !== listFilter.difficulty) return false
    if (listFilter.category && q.category !== listFilter.category) return false
    if (searchKeyword) {
      const kw = searchKeyword.toLowerCase()
      return q.stem.toLowerCase().includes(kw) || (q.tags || []).some(t => t.toLowerCase().includes(kw))
    }
    return true
  })

  const listEl = document.getElementById('question-list')
  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty">暂无题目</div>'
    return
  }
  listEl.innerHTML = filtered.map((q, i) => `
    <div class="card question-item" onclick="startPractice('${q.id || i}')">
      <div class="question-header">
        ${diffTag(q.difficulty)}
        <span class="text-muted question-category">${CATEGORIES[q.category] || q.category}</span>
      </div>
      <div class="question-stem">${formatContent(q.stem)}</div>
    </div>
  `).join('')
}

function setDifficulty(val) {
  listFilter.difficulty = val
  document.querySelectorAll('.diff-chip').forEach(el => {
    el.classList.toggle('active', el.dataset.val === val)
  })
  renderList()
}

function setCategory(val) {
  listFilter.category = val
  document.querySelectorAll('.cat-chip').forEach(el => {
    el.classList.toggle('active', el.dataset.val === val)
  })
  renderList()
}

function onSearch(val) {
  searchKeyword = val
  renderList()
}

// ========== 答题页 ==========
let practiceQuestions = []
let practiceIndex = 0
let practiceSelected = null
let practiceShowResult = false

function startPractice(idOrIdx) {
  const idx = parseInt(idOrIdx)
  const q = QUESTIONS[idx] || QUESTIONS.find(q => q.id === idOrIdx)
  if (!q) return

  practiceQuestions = [q]
  practiceIndex = 0
  practiceSelected = null
  practiceShowResult = false
  practiceSessionAnswers = []

  if (listFilter.difficulty || listFilter.category) {
    practiceQuestions = QUESTIONS.filter(q => {
      if (listFilter.difficulty && q.difficulty !== listFilter.difficulty) return false
      if (listFilter.category && q.category !== listFilter.category) return false
      return true
    })
    practiceIndex = practiceQuestions.indexOf(q)
    if (practiceIndex === -1) { practiceQuestions = [q]; practiceIndex = 0 }
  } else {
    practiceQuestions = shuffleArray(QUESTIONS)
    const targetIdx = practiceQuestions.indexOf(q)
    if (targetIdx > 0) {
      [practiceQuestions[0], practiceQuestions[targetIdx]] = [practiceQuestions[targetIdx], practiceQuestions[0]]
    }
    practiceIndex = 0
  }

  renderPractice()
  showPage('practice')
}

function startRandomPractice() {
  practiceQuestions = shuffleArray(QUESTIONS)
  practiceIndex = 0
  practiceSelected = null
  practiceShowResult = false
  practiceSessionAnswers = []
  renderPractice()
  showPage('practice')
}

function renderPractice() {
  const q = practiceQuestions[practiceIndex]
  if (!q) return

  const progress = ((practiceIndex + 1) / practiceQuestions.length * 100).toFixed(0)
  const container = document.getElementById('practice-content')

  container.innerHTML = `
    <span class="progress-text">${practiceIndex + 1} / ${practiceQuestions.length}</span>
    <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>

    <div class="question-meta">
      ${diffTag(q.difficulty)}
      ${(q.tags || []).slice(0, 2).map(t => `<span class="tag">${t}</span>`).join('')}
    </div>

    <div class="card">
      <div class="practice-stem">${formatContent(q.stem)}</div>
    </div>

    <div class="options-area">
      ${q.options.map(o => {
        let cls = 'option-card'
        if (practiceShowResult) {
          if (o.correct) cls += ' correct'
          else if (o.label === practiceSelected) cls += ' wrong'
        } else if (o.label === practiceSelected) {
          cls += ' selected'
        }
        return `<div class="${cls}" onclick="selectOption('${o.label}')">
          <div class="option-label">${o.label}</div>
          <div class="option-text">${formatContent(o.text)}</div>
          ${practiceShowResult && o.correct ? '<div class="option-icon">✓</div>' : ''}
          ${practiceShowResult && o.label === practiceSelected && !o.correct ? '<div class="option-icon">✗</div>' : ''}
        </div>`
      }).join('')}
    </div>

    ${practiceShowResult ? `
      <div class="card" style="padding:0;overflow:hidden">
        <div class="result-banner ${practiceQuestions[practiceIndex].options.find(o => o.label === practiceSelected)?.correct ? 'correct-banner' : 'wrong-banner'}">
          ${practiceQuestions[practiceIndex].options.find(o => o.label === practiceSelected)?.correct ? '回答正确！' : '回答错误'}
        </div>
        <div class="explanation-content">
          <span class="explanation-title">解析</span>
          <div class="explanation-text">${formatContent(q.explanation)}</div>
        </div>
      </div>
      <div class="next-btn" onclick="nextQuestion()">
        ${practiceIndex + 1 < practiceQuestions.length ? '下一题' : '返回'}
      </div>
    ` : ''}
  `
}

function selectOption(label) {
  if (practiceShowResult) return
  practiceSelected = label
  practiceShowResult = true

  const q = practiceQuestions[practiceIndex]
  const isCorrect = q.options.find(o => o.label === label)?.correct || false
  practiceSessionAnswers.push({ questionId: q.id, isCorrect, question: q })
  saveRecord({
    questionId: q.id || practiceIndex,
    chosenOption: label,
    isCorrect,
    time: new Date().toISOString()
  })

  renderPractice()
}

function nextQuestion() {
  if (practiceIndex + 1 < practiceQuestions.length) {
    practiceIndex++
    practiceSelected = null
    practiceShowResult = false
    renderPractice()
    window.scrollTo(0, 0)
  } else {
    renderPracticeResult()
  }
}

function renderPracticeResult() {
  const answers = practiceSessionAnswers
  const total = answers.length
  const correct = answers.filter(a => a.isCorrect).length
  const accuracy = total > 0 ? Math.round(correct / total * 100) : 0
  const container = document.getElementById('practice-content')

  const wrongAnswers = answers.filter(a => !a.isCorrect)
  const categoryStats = {}
  answers.forEach(a => {
    const cat = a.question.category
    if (!categoryStats[cat]) categoryStats[cat] = { correct: 0, total: 0 }
    categoryStats[cat].total++
    if (a.isCorrect) categoryStats[cat].correct++
  })

  container.innerHTML = `
    <div class="nav-bar">
      <span class="nav-title">本次结果</span>
    </div>
    <div class="result-summary-card">
      <div class="result-summary-ring">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(58,158,143,0.1)" stroke-width="8"/>
          <circle cx="60" cy="60" r="50" fill="none" stroke="#3A9E8F" stroke-width="8"
            stroke-dasharray="${Math.PI * 100}" stroke-dashoffset="${Math.PI * 100 * (1 - accuracy / 100)}"
            stroke-linecap="round" transform="rotate(-90 60 60)"
            style="transition:stroke-dashoffset 1s ease"/>
          <text x="60" y="54" text-anchor="middle" fill="#1A2B3C" font-size="28" font-weight="700">${accuracy}%</text>
          <text x="60" y="74" text-anchor="middle" fill="#9AABB8" font-size="12">正确率</text>
        </svg>
      </div>
      <div class="result-summary-stats">
        <div class="result-summary-item">
          <span class="result-summary-num">${total}</span>
          <span class="result-summary-label">总题数</span>
        </div>
        <div class="result-summary-item">
          <span class="result-summary-num" style="color:var(--success)">${correct}</span>
          <span class="result-summary-label">答对</span>
        </div>
        <div class="result-summary-item">
          <span class="result-summary-num" style="color:var(--danger)">${total - correct}</span>
          <span class="result-summary-label">答错</span>
        </div>
      </div>
    </div>
    ${Object.keys(categoryStats).length > 1 ? `
    <div class="card">
      <div class="section-title">分类表现</div>
      ${Object.entries(categoryStats).map(([cat, s]) => {
        const acc = Math.round(s.correct / s.total * 100)
        const barColor = acc >= 80 ? 'var(--success)' : acc >= 50 ? 'var(--warning)' : 'var(--danger)'
        return `<div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:13px">${CATEGORIES[cat] || cat}</span>
            <span style="font-size:12px;color:var(--text-muted)">${s.correct}/${s.total} (${acc}%)</span>
          </div>
          <div style="height:5px;background:rgba(45,90,78,0.06);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${acc}%;background:${barColor};border-radius:3px;transition:width 0.5s"></div>
          </div>
        </div>`
      }).join('')}
    </div>
    ` : ''}
    ${wrongAnswers.length > 0 ? `
    <div class="card">
      <div class="section-title">错题回顾</div>
      ${wrongAnswers.map(a => {
        const correctOpt = a.question.options.find(o => o.correct)
        return `<div class="practice-result-wrong-item">
          <div class="practice-result-wrong-stem">${a.question.stem.slice(0, 60)}${a.question.stem.length > 60 ? '...' : ''}</div>
          <div class="practice-result-wrong-ans">正确答案：${correctOpt?.label}. ${correctOpt?.text.slice(0, 40)}${correctOpt?.text.length > 40 ? '...' : ''}</div>
        </div>`
      }).join('')}
    </div>
    ` : ''}
    <div class="action-row">
      <div class="action-btn btn-primary" onclick="startSmartPractice()">再来一组</div>
      <div class="action-btn btn-outline" onclick="practiceSessionAnswers=[];showPage('home')">返回首页</div>
    </div>
  `
}

// ========== 错题本 ==========
function renderWrongBook() {
  const wrongBook = getWrongBook().filter(w => !w.reviewed)
  const listEl = document.getElementById('wrong-list')
  const countEl = document.getElementById('wrong-count')

  countEl.textContent = wrongBook.length

  if (wrongBook.length === 0) {
    listEl.innerHTML = '<div class="empty">暂无错题，继续保持！</div>'
    return
  }

  listEl.innerHTML = wrongBook.map(w => {
    const q = QUESTIONS[w.questionId] || QUESTIONS.find((q, i) => (q.id || i) === w.questionId)
    if (!q) return ''
    return `
      <div class="card wrong-item">
        <div class="wrong-content" onclick="startPractice('${w.questionId}')">
          <div class="wrong-meta">${diffTag(q.difficulty)}</div>
          <div class="wrong-stem">${formatContent(q.stem)}</div>
        </div>
        <div class="wrong-actions">
          <span class="action-redo" onclick="startPractice('${w.questionId}')">重做</span>
          <span class="action-remove" onclick="removeWrongAndRefresh('${w.questionId}')">移除</span>
        </div>
      </div>
    `
  }).join('')
}

function removeWrongAndRefresh(questionId) {
  removeWrongItem(parseInt(questionId) || questionId)
  renderWrongBook()
}

// ========== 个人中心 ==========
function refreshProfile() {
  const stats = getStats()
  document.getElementById('p-total').textContent = stats.total
  document.getElementById('p-correct').textContent = stats.correct
  document.getElementById('p-accuracy').textContent = stats.accuracy + '%'
  document.getElementById('p-wrong').textContent = stats.wrongCount
  document.getElementById('p-today').textContent = stats.todayCount

  const profile = getUserProfile()
  const descEl = document.getElementById('profile-level-desc')
  if (profile && profile.assessmentDone) {
    const levelDef = getLevelDef(profile.level)
    descEl.textContent = `${levelDef.name} · ${levelDef.desc}`
  }
}

// ========== 使用说明 ==========
function showHelpPage() {
  showPage('practice')
  const container = document.getElementById('practice-content')
  container.innerHTML = `
    <div class="nav-bar">
      <span class="nav-back" onclick="showPage('profile')"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></span>
      <span class="nav-title">使用说明</span>
    </div>

    <div class="card">
      <div class="section-title">关于 SQL刷题</div>
      <p class="help-text">SQL刷题是一款面向 SQL 学习者的刷题工具，涵盖 10 大知识点、600+ 道精选选择题，通过智能推题算法为你量身定制学习路径，帮助你高效掌握 SQL。</p>
    </div>

    <div class="card">
      <div class="section-title">等级体系</div>
      <p class="help-text" style="margin-bottom:12px">完成入学测评后获得初始等级，通过满足条件解锁晋阶挑战，挑战通过即可升级。</p>
      ${LEVELS.map(l => `
        <div class="help-level-item">
          <span class="help-level-icon" style="color:${getLevelColor(l.level)}">${getLevelIcon(l.level)}</span>
          <div class="help-level-info">
            <span class="help-level-name" style="color:${getLevelColor(l.level)}">Lv.${l.level} ${l.name}</span>
            <span class="help-level-desc">${l.desc}</span>
          </div>
        </div>
      `).join('')}
    </div>

    <div class="card">
      <div class="section-title">晋阶条件</div>
      <p class="help-text" style="margin-bottom:12px">每个等级需要同时满足以下所有条件，才能解锁晋阶挑战（10 题，答对 8 题通过）：</p>
      <div class="help-table">
        <div class="help-table-header">
          <span>等级</span><span>做题数</span><span>正确率</span><span>板块正确率</span><span>错题清空</span><span>近期表现</span>
        </div>
        <div class="help-table-row"><span>Lv.1→2</span><span>50</span><span>≥60%</span><span>≥70%</span><span>≥80%</span><span>近20题对14</span></div>
        <div class="help-table-row"><span>Lv.2→3</span><span>120</span><span>≥65%</span><span>≥70%</span><span>≥80%</span><span>近20题对14</span></div>
        <div class="help-table-row"><span>Lv.3→4</span><span>200</span><span>≥70%</span><span>≥70%</span><span>≥80%</span><span>近20题对15</span></div>
        <div class="help-table-row"><span>Lv.4→5</span><span>350</span><span>≥75%</span><span>≥70%</span><span>≥90%</span><span>近20题对16</span></div>
      </div>
      <p class="help-text" style="margin-top:10px">板块正确率：当前等级对应板块的答题正确率。挑战失败后需等待 24 小时冷却。</p>
    </div>

    <div class="card">
      <div class="section-title">智能推题算法</div>
      <p class="help-text">系统不是随机出题，而是根据你的学习数据动态调整：</p>
      <div class="help-algo-list">
        <div class="help-algo-item">
          <div class="help-algo-num">1</div>
          <div>
            <div class="help-algo-title">板块加权轮转</div>
            <div class="help-algo-desc">每个板块有一个动态权重。错题多的板块权重升高，答对的板块权重降低。每次推题优先从高权重板块出题。</div>
          </div>
        </div>
        <div class="help-algo-item">
          <div class="help-algo-num">2</div>
          <div>
            <div class="help-algo-title">难度偏好匹配</div>
            <div class="help-algo-desc">不同等级对应不同难度配比。小白阶段偏简单题（70%），老炮阶段偏困难题（80%），循序渐进。</div>
          </div>
        </div>
        <div class="help-algo-item">
          <div class="help-algo-num">3</div>
          <div>
            <div class="help-algo-title">已做去重</div>
            <div class="help-algo-desc">优先推送未做过的题。当剩余未做题不足 10 题时自动重置，确保题量充足。</div>
          </div>
        </div>
        <div class="help-algo-item">
          <div class="help-algo-num">4</div>
          <div>
            <div class="help-algo-title">掌握判定</div>
            <div class="help-algo-desc">某板块累计答题 ≥30 次且正确率 >80% 时标记为已掌握，权重降至最低，精力集中在薄弱项。</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="section-title">权重公式</div>
      <div class="help-formula">
        <code>权重 = 1.0 + min(错题数 × 0.15, 2.0) - min(答对数 × 0.05, 1.5)</code>
      </div>
      <p class="help-text" style="margin-top:8px">最终值不低于 0.2，已掌握板块固定为 0.1。这意味着：你越薄弱的板块出现频率越高，直到你补上来为止。</p>
    </div>

    <div class="card">
      <div class="section-title">题库概览</div>
      <div class="help-cat-grid">
        ${Object.entries(CATEGORIES).map(([key, name]) => {
          const count = QUESTIONS.filter(q => q.category === key).length
          return `<div class="help-cat-item">
            ${TYPE_ICONS[key] || ''}
            <span class="help-cat-name">${name}</span>
            <span class="help-cat-count">${count}题</span>
          </div>`
        }).join('')}
      </div>
      <p class="help-text" style="margin-top:10px">每道题分为简单 / 中等 / 困难三档难度，涵盖知识点型、SQL结果型、SQL补全型、排错型四种题型。</p>
    </div>

    <div class="next-btn" onclick="showPage('profile')">返回</div>
  `
}

// ========== 排行榜（本地） ==========
function showRankPage() {
  showPage('practice')
  const records = getRecords()
  const total = records.length
  const correct = records.filter(r => r.isCorrect).length
  const accuracy = total > 0 ? Math.round(correct / total * 100) : 0
  const profile = getUserProfile()

  const container = document.getElementById('practice-content')
  container.innerHTML = `
    <div class="nav-bar">
      <span class="nav-back" onclick="showPage('profile')"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></span>
      <span class="nav-title">学习报告</span>
    </div>
    <div class="card stats-card">
      <div class="stats-title">我的成绩</div>
      <div class="stats-row" style="margin-top:12px">
        <div class="stats-item"><span class="stats-num">${total}</span><span class="stats-label">总答题</span></div>
        <div class="stats-item"><span class="stats-num">${correct}</span><span class="stats-label">答对</span></div>
        <div class="stats-item"><span class="stats-num">${accuracy}%</span><span class="stats-label">正确率</span></div>
      </div>
    </div>
    ${profile && profile.assessmentDone ? `
    <div class="card">
      <div class="section-title">段位信息</div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div class="level-icon-box" style="background:${getLevelColor(profile.level)}22">${getLevelIcon(profile.level)}</div>
        <div>
          <div style="font-size:18px;font-weight:700;color:${getLevelColor(profile.level)}">${profile.levelName}</div>
          <div style="font-size:12px;color:var(--text-muted)">${getLevelDef(profile.level).desc}</div>
        </div>
      </div>
    </div>
    ` : ''}
    <div class="card">
      <div class="section-title">知识点掌握</div>
      <canvas id="radar-chart" width="400" height="400" style="width:100%;max-width:400px;margin:0 auto;display:block"></canvas>
      <div class="radar-legend">
        ${Object.entries(CATEGORIES).map(([key, name]) => {
          const catRecords2 = records.filter(r => {
            const q = QUESTIONS.find(qq => qq.id === r.questionId)
            return q && q.category === key
          })
          const catTotal = catRecords2.length
          const catCorrect = catRecords2.filter(r => r.isCorrect).length
          const catAcc = catTotal > 0 ? Math.round(catCorrect / catTotal * 100) : 0
          const dotColor = catAcc >= 80 ? 'var(--success)' : catAcc >= 50 ? 'var(--warning)' : 'var(--danger)'
          return `<div class="radar-legend-item">
            <span class="radar-legend-dot" style="background:${dotColor}"></span>
            <span class="radar-legend-name">${name}</span>
            <span class="radar-legend-val">${catAcc}%</span>
          </div>`
        }).join('')}
      </div>
    </div>
    <div class="next-btn" onclick="showPage('profile')">返回</div>
  `
  drawRadarChart(records)
}

// ========== 雷达图 ==========
function drawRadarChart(records) {
  const canvas = document.getElementById('radar-chart')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const w = 400, h = 400
  canvas.width = w * dpr
  canvas.height = h * dpr
  ctx.scale(dpr, dpr)

  const cats = Object.keys(CATEGORIES)
  const n = cats.length
  const cx = w / 2, cy = h / 2
  const maxR = 140

  // 计算每个分类的答题正确率（该板块所有答题记录的正确比例）
  const values = cats.map(cat => {
    const catRecords = records.filter(r => {
      const q = QUESTIONS.find(qq => qq.id === r.questionId)
      return q && q.category === cat
    })
    if (catRecords.length === 0) return 0
    const correct = catRecords.filter(r => r.isCorrect).length
    return correct / catRecords.length
  })

  const angleStep = (Math.PI * 2) / n
  const startAngle = -Math.PI / 2

  function getPoint(i, ratio) {
    const a = startAngle + i * angleStep
    return { x: cx + Math.cos(a) * maxR * ratio, y: cy + Math.sin(a) * maxR * ratio }
  }

  // 清除
  ctx.clearRect(0, 0, w, h)

  // 背景辉光
  const bgGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR + 40)
  bgGlow.addColorStop(0, 'rgba(58,158,143,0.06)')
  bgGlow.addColorStop(1, 'rgba(58,158,143,0.0)')
  ctx.fillStyle = bgGlow
  ctx.fillRect(0, 0, w, h)

  // 网格层（4层）
  for (let level = 1; level <= 4; level++) {
    const ratio = level / 4
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const p = getPoint(i, ratio)
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    ctx.strokeStyle = level === 4 ? 'rgba(58,158,143,0.18)' : 'rgba(58,158,143,0.08)'
    ctx.lineWidth = level === 4 ? 1.2 : 0.8
    ctx.stroke()

    // 刻度数字
    if (level % 2 === 0) {
      const lp = getPoint(0, ratio)
      ctx.fillStyle = 'rgba(58,158,143,0.3)'
      ctx.font = '10px sans-serif'
      ctx.fillText((level * 25) + '', lp.x + 4, lp.y + 3)
    }
  }

  // 轴线
  for (let i = 0; i < n; i++) {
    const p = getPoint(i, 1)
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(p.x, p.y)
    ctx.strokeStyle = 'rgba(58,158,143,0.1)'
    ctx.lineWidth = 0.8
    ctx.stroke()
  }

  // 数据区域填充
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const p = getPoint(i, Math.max(values[i], 0.05))
    i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
  }
  ctx.closePath()
  const fillGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR)
  fillGrad.addColorStop(0, 'rgba(58,158,143,0.35)')
  fillGrad.addColorStop(1, 'rgba(58,158,143,0.08)')
  ctx.fillStyle = fillGrad
  ctx.fill()

  // 数据描边 + 发光
  ctx.save()
  ctx.shadowColor = 'rgba(58,158,143,0.6)'
  ctx.shadowBlur = 12
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const p = getPoint(i, Math.max(values[i], 0.05))
    i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
  }
  ctx.closePath()
  ctx.strokeStyle = 'rgba(58,158,143,0.9)'
  ctx.lineWidth = 2.2
  ctx.stroke()
  ctx.restore()

  // 数据点
  for (let i = 0; i < n; i++) {
    const p = getPoint(i, Math.max(values[i], 0.05))
    // 外发光
    ctx.save()
    ctx.shadowColor = 'rgba(58,158,143,0.8)'
    ctx.shadowBlur = 8
    ctx.beginPath()
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#3A9E8F'
    ctx.fill()
    ctx.restore()
    // 内核
    ctx.beginPath()
    ctx.arc(p.x, p.y, 2, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
  }

  // 标签
  ctx.font = '600 12px -apple-system, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < n; i++) {
    const name = CATEGORIES[cats[i]]
    const val = Math.round(values[i] * 100)
    const a = startAngle + i * angleStep
    const labelR = maxR + 28
    const lx = cx + Math.cos(a) * labelR
    const ly = cy + Math.sin(a) * labelR

    ctx.fillStyle = '#1A2B3C'
    ctx.fillText(name, lx, ly - 7)
    ctx.fillStyle = val >= 80 ? '#43A047' : val >= 50 ? '#FB8C00' : '#E53935'
    ctx.font = '700 11px -apple-system, sans-serif'
    ctx.fillText(val + '%', lx, ly + 8)
    ctx.font = '600 12px -apple-system, sans-serif'
  }

  // 中心装饰
  ctx.beginPath()
  ctx.arc(cx, cy, 3, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(58,158,143,0.3)'
  ctx.fill()
}

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => showPage(tab.dataset.page))
  })

  QUESTIONS.forEach((q, i) => { if (!q.id && q.id !== 0) q.id = i })

  await detectOnline()

  renderList()
  refreshHome()
  showPage('home')
})
