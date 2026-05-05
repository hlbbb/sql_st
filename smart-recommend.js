// ========== 智能推题系统 ==========

// 等级定义
const LEVELS = [
  { level: 1, name: '小白一枚', icon: 'seedling', desc: 'SELECT 是啥？一切从零开始', difficulty: { easy: 0.70, medium: 0.25, hard: 0.05 } },
  { level: 2, name: '上道儿了', icon: 'fire', desc: 'WHERE GROUP BY 拿来吧你', difficulty: { easy: 0.60, medium: 0.30, hard: 0.10 } },
  { level: 3, name: '拿捏了', icon: 'star', desc: '多表 JOIN 也不在话下', difficulty: { easy: 0.30, medium: 0.50, hard: 0.20 } },
  { level: 4, name: '稳如老狗', icon: 'target', desc: '子查询窗口函数？基操勿6', difficulty: { easy: 0.10, medium: 0.40, hard: 0.50 } },
  { level: 5, name: 'SQL老炮', icon: 'rocket', desc: '没有我写不出的SQL', difficulty: { easy: 0.00, medium: 0.20, hard: 0.80 } }
]

// 板块轮转顺序
const BOARD_ORDER = [
  'basic', 'condition_date', 'aggregate', 'string_cast', 'result_set',
  'join', 'subquery', 'window', 'dml', 'analytics'
]

// SVG 图标
const LEVEL_ICONS = {
  seedling: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 20h10"/><path d="M10 20c0-4-3-7-6-7"/><path d="M14 20c0-4 3-7 6-7"/><path d="M12 20v-8"/><path d="M12 12C12 6 7 2 7 2s5 2 5 10"/><path d="M12 8c0-4 5-6 5-6s-5 2-5 6"/></svg>',
  fire: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 22c4-2 8-6 8-11 0-3-2-6-5-7-1 2-3 3-5 3-1-2-1-4 0-6-4 1-6 5-6 8 0 5 4 9 8 13z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>'
}

// ========== 用户画像存储 ==========
const PROFILE_KEY = 'sql_user_profile'
const DONE_KEY = 'sql_done_questions'

function getDefaultProfile() {
  const weights = {}
  BOARD_ORDER.forEach(cat => {
    weights[cat] = { weight: 1.0, correct: 0, wrong: 0, mastered: false }
  })
  return {
    level: 1,
    levelName: '小白一枚',
    assessmentDone: false,
    boardWeights: weights,
    promotion: {
      eligible: false,
      lastChallengeTime: null,
      challengeCount: 0,
      cooldownUntil: null
    }
  }
}

function getUserProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return null
    const profile = JSON.parse(raw)
    // 向后兼容：确保所有板块都存在
    BOARD_ORDER.forEach(cat => {
      if (!profile.boardWeights[cat]) {
        profile.boardWeights[cat] = { weight: 1.0, correct: 0, wrong: 0, mastered: false }
      }
    })
    if (!profile.promotion) {
      profile.promotion = { eligible: false, lastChallengeTime: null, challengeCount: 0, cooldownUntil: null }
    }
    return profile
  } catch {
    return null
  }
}

function saveUserProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
}

function getDoneQuestions() {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveDoneQuestions(ids) {
  localStorage.setItem(DONE_KEY, JSON.stringify(ids))
}

// ========== 板块权重计算 ==========
function calculateWeight(entry) {
  const baseWeight = 1.0
  const wrongBonus = Math.min(entry.wrong * 0.15, 2.0)
  const masterDecay = Math.min(entry.correct * 0.05, 1.5)
  const raw = baseWeight + wrongBonus - masterDecay
  return Math.max(0.2, raw)
}

function recalculateAllWeights(boardWeights) {
  const result = {}
  BOARD_ORDER.forEach(cat => {
    const entry = { ...boardWeights[cat] }
    if (entry.mastered) {
      entry.weight = 0.1
    } else {
      entry.weight = calculateWeight(entry)
    }
    result[cat] = entry
  })
  return result
}

// ========== 掌握判定 ==========
function checkMastery(boardWeights) {
  const result = {}
  BOARD_ORDER.forEach(cat => {
    const entry = boardWeights[cat]
    const total = entry.correct + entry.wrong
    const acc = total > 0 ? entry.correct / total : 0
    result[cat] = { ...entry, mastered: total >= 30 && acc > 0.8 }
  })
  return result
}

function isAllMastered(boardWeights) {
  return BOARD_ORDER.every(cat => boardWeights[cat].mastered)
}

// ========== 智能选题 ==========
function pickDifficulty(level) {
  const levelDef = LEVELS.find(l => l.level === level) || LEVELS[0]
  const r = Math.random()
  const { easy, medium, hard } = levelDef.difficulty
  if (r < easy) return 'easy'
  if (r < easy + medium) return 'medium'
  return 'hard'
}

function pickBoard(boardWeights) {
  const entries = BOARD_ORDER.filter(cat => !boardWeights[cat].mastered)
  if (entries.length === 0) return BOARD_ORDER[Math.floor(Math.random() * BOARD_ORDER.length)]

  const totalWeight = entries.reduce((sum, cat) => sum + boardWeights[cat].weight, 0)
  let r = Math.random() * totalWeight
  for (const cat of entries) {
    r -= boardWeights[cat].weight
    if (r <= 0) return cat
  }
  return entries[entries.length - 1]
}

function smartPickQuestion() {
  const profile = getUserProfile()
  if (!profile) return null

  const { boardWeights } = profile
  let doneIds = getDoneQuestions()

  // 过滤已做过的题
  let available = QUESTIONS.filter(q => !doneIds.includes(q.id))

  // 不足10题时重置
  if (available.length < 10) {
    doneIds = []
    saveDoneQuestions(doneIds)
    available = [...QUESTIONS]
  }

  // 加权随机选板块
  const board = pickBoard(boardWeights)

  // 按等级难度偏好选题
  const difficulty = pickDifficulty(profile.level)

  // 先尝试精确匹配（板块 + 难度）
  let candidates = available.filter(q => q.category === board && q.difficulty === difficulty)

  // 放宽：只匹配板块
  if (candidates.length === 0) {
    candidates = available.filter(q => q.category === board)
  }

  // 放宽：只匹配难度
  if (candidates.length === 0) {
    candidates = available.filter(q => q.difficulty === difficulty)
  }

  // 兜底：所有可用题
  if (candidates.length === 0) {
    candidates = available
  }

  if (candidates.length === 0) return null

  return candidates[Math.floor(Math.random() * candidates.length)]
}

// ========== 答题后更新权重 ==========
function updateAfterAnswer(questionId, isCorrect) {
  const profile = getUserProfile()
  if (!profile) return

  const q = QUESTIONS.find(qq => qq.id === questionId)
  if (!q) return

  const entry = profile.boardWeights[q.category]
  if (isCorrect) {
    entry.correct += 1
  } else {
    entry.wrong += 1
  }

  // 重新计算权重
  profile.boardWeights = recalculateAllWeights(checkMastery(profile.boardWeights))
  saveUserProfile(profile)

  // 更新已做题目
  const done = getDoneQuestions()
  if (!done.includes(questionId)) {
    done.push(questionId)
    saveDoneQuestions(done)
  }
}

// ========== 等级工具函数 ==========
function getLevelDef(level) {
  return LEVELS.find(l => l.level === level) || LEVELS[0]
}

function getLevelIcon(level) {
  const def = getLevelDef(level)
  return LEVEL_ICONS[def.icon] || ''
}

function getLevelColor(level) {
  const colors = {
    1: '#8BC34A',
    2: '#FF9800',
    3: '#FFD700',
    4: '#E91E63',
    5: '#9C27B0'
  }
  return colors[level] || '#8BC34A'
}
