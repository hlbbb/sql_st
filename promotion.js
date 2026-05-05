// ========== 晋阶挑战系统 ==========

// 晋阶条件配置
const PROMOTION_REQUIREMENTS = [
  null, // L0不存在
  { totalDone: 50, accuracy: 60, boardAccuracy: 70, wrongClearRate: 80, recentCorrect: 14, recentTotal: 20, boards: ['basic', 'condition_date'] },
  { totalDone: 120, accuracy: 65, boardAccuracy: 70, wrongClearRate: 80, recentCorrect: 14, recentTotal: 20, boards: ['aggregate', 'string_cast', 'result_set'] },
  { totalDone: 200, accuracy: 70, boardAccuracy: 70, wrongClearRate: 80, recentCorrect: 15, recentTotal: 20, boards: ['join', 'subquery'] },
  { totalDone: 350, accuracy: 75, boardAccuracy: 70, wrongClearRate: 90, recentCorrect: 16, recentTotal: 20, boards: ['window', 'dml', 'analytics'] }
]

// 挑战题目配置
const CHALLENGE_CONFIG = {
  1: { boards: ['condition_date', 'aggregate'], difficulty: { easy: 0.50, medium: 0.40, hard: 0.10 } },
  2: { boards: ['join', 'subquery'], difficulty: { easy: 0.20, medium: 0.50, hard: 0.30 } },
  3: { boards: ['window', 'analytics'], difficulty: { easy: 0.10, medium: 0.40, hard: 0.50 } },
  4: { boards: BOARD_ORDER, difficulty: { easy: 0.00, medium: 0.30, hard: 0.70 } }
}

let challengeState = null

// ========== 晋阶条件检查 ==========
function checkPromotionEligibility() {
  const profile = getUserProfile()
  if (!profile || !profile.assessmentDone) return { eligible: false, reasons: [] }
  if (profile.level >= 5) return { eligible: false, reasons: [], maxLevel: true }

  const req = PROMOTION_REQUIREMENTS[profile.level]
  if (!req) return { eligible: false, reasons: [] }

  const records = getRecords()
  const wrongBook = getWrongBook()
  const reasons = []
  let allMet = true

  // 1. 累计做题数
  const totalDone = records.length
  if (totalDone < req.totalDone) {
    allMet = false
    reasons.push({ text: `再做 ${req.totalDone - totalDone} 题`, met: false, detail: `已做 ${totalDone}/${req.totalDone} 题` })
  } else {
    reasons.push({ text: `做题数达标`, met: true, detail: `已做 ${totalDone}/${req.totalDone} 题` })
  }

  // 2. 总正确率
  const totalCorrect = records.filter(r => r.isCorrect).length
  const accuracy = totalDone > 0 ? Math.round(totalCorrect / totalDone * 100) : 0
  if (accuracy < req.accuracy) {
    allMet = false
    reasons.push({ text: `正确率还需提升 ${req.accuracy - accuracy}%`, met: false, detail: `当前 ${accuracy}%/${req.accuracy}%` })
  } else {
    reasons.push({ text: `正确率达标`, met: true, detail: `当前 ${accuracy}%/${req.accuracy}%` })
  }

  // 3. 当前等级板块正确率
  const boardRecords = records.filter(r => {
    const q = QUESTIONS.find(qq => qq.id === r.questionId)
    return q && req.boards.includes(q.category)
  })
  const boardTotal = boardRecords.length
  const boardCorrect = boardRecords.filter(r => r.isCorrect).length
  const boardAcc = boardTotal > 0 ? Math.round(boardCorrect / boardTotal * 100) : 0
  if (boardAcc < req.boardAccuracy) {
    allMet = false
    reasons.push({ text: `板块正确率需达 ${req.boardAccuracy}%`, met: false, detail: `当前 ${boardAcc}%` })
  } else {
    reasons.push({ text: `板块正确率达标`, met: true, detail: `当前 ${boardAcc}%` })
  }

  // 4. 错题重做清零率
  const wrongTotal = wrongBook.length
  const reviewedCount = wrongBook.filter(w => w.reviewed).length
  const clearRate = wrongTotal > 0 ? Math.round(reviewedCount / wrongTotal * 100) : 100
  if (clearRate < req.wrongClearRate) {
    allMet = false
    reasons.push({ text: `错题还需清空 ${req.wrongClearRate - clearRate}%`, met: false, detail: `已清 ${clearRate}%/${req.wrongClearRate}%` })
  } else {
    reasons.push({ text: `错题清空达标`, met: true, detail: `已清 ${clearRate}%/${req.wrongClearRate}%` })
  }

  // 5. 最近N题答对数
  const recent = records.slice(-req.recentTotal)
  const recentCorrect = recent.filter(r => r.isCorrect).length
  if (recentCorrect < req.recentCorrect) {
    allMet = false
    reasons.push({ text: `最近${req.recentTotal}题还需对${req.recentCorrect - recentCorrect}题`, met: false, detail: `已对 ${recentCorrect}/${req.recentCorrect}` })
  } else {
    reasons.push({ text: `近期表现达标`, met: true, detail: `已对 ${recentCorrect}/${req.recentCorrect}` })
  }

  // 6. 冷却检查
  const promo = profile.promotion || {}
  if (promo.cooldownUntil && new Date(promo.cooldownUntil) > new Date()) {
    allMet = false
    const remain = new Date(promo.cooldownUntil) - new Date()
    const hours = Math.ceil(remain / 3600000)
    reasons.push({ text: `冷却中，还需${hours}小时`, met: false, detail: '挑战失败后需等待24小时' })
  }

  return { eligible: allMet, reasons, nextLevel: profile.level + 1 }
}

// ========== 晋阶挑战 ==========
function startChallenge() {
  const profile = getUserProfile()
  if (!profile || profile.level >= 5) return

  const config = CHALLENGE_CONFIG[profile.level]
  if (!config) return

  // 选题：从目标板块中按难度配比选10题
  const pool = QUESTIONS.filter(q => config.boards.includes(q.category))
  const selected = pickChallengeQuestions(pool, config.difficulty, 10)

  if (selected.length < 10) {
    alert('题目不足，无法开始挑战')
    return
  }

  challengeState = {
    questions: selected,
    index: 0,
    correct: 0,
    answers: [],
    finished: false,
    passed: false
  }

  renderChallenge()
  showPage('assessment')
}

function pickChallengeQuestions(pool, difficultyRatio, count) {
  const result = []
  const remaining = [...pool]

  // 按难度配比选
  const counts = {
    easy: Math.round(count * difficultyRatio.easy),
    medium: Math.round(count * difficultyRatio.medium),
    hard: 0
  }
  counts.hard = count - counts.easy - counts.medium

  for (const [diff, num] of Object.entries(counts)) {
    const candidates = remaining.filter(q => q.difficulty === diff)
    const picked = shuffleArray(candidates).slice(0, num)
    picked.forEach(q => {
      result.push(q)
      const idx = remaining.indexOf(q)
      if (idx > -1) remaining.splice(idx, 1)
    })
  }

  // 不足的用任意题补
  while (result.length < count && remaining.length > 0) {
    const idx = Math.floor(Math.random() * remaining.length)
    result.push(remaining[idx])
    remaining.splice(idx, 1)
  }

  return shuffleArray(result).slice(0, count)
}

function renderChallenge() {
  const st = challengeState
  if (!st) return

  const container = document.getElementById('assessment-content')

  if (st.finished) {
    renderChallengeResult(container)
    return
  }

  const q = st.questions[st.index]
  const progress = ((st.index + 1) / st.questions.length * 100).toFixed(0)

  container.innerHTML = `
    <div class="nav-bar">
      <span class="nav-title" style="color:var(--warning)">晋阶挑战</span>
    </div>
    <span class="progress-text">第 ${st.index + 1} / ${st.questions.length} 题 | 已对 ${st.correct} 题</span>
    <div class="progress-bar">
      <div class="progress-fill challenge-progress" style="width:${progress}%"></div>
    </div>
    <div class="question-meta">
      ${diffTag(q.difficulty)}
      <span class="tag">${CATEGORIES[q.category] || q.category}</span>
    </div>
    <div class="card">
      <div class="practice-stem">${formatContent(q.stem)}</div>
    </div>
    <div class="options-area" id="challenge-options">
      ${q.options.map(o => `
        <div class="option-card" onclick="selectChallengeOption('${o.label}', ${q.id})">
          <div class="option-label">${o.label}</div>
          <div class="option-text">${formatContent(o.text)}</div>
        </div>
      `).join('')}
    </div>
  `
}

let challengeSelected = null
let challengeShowResult = false

function selectChallengeOption(label, questionId) {
  if (challengeShowResult) return
  challengeSelected = label
  challengeShowResult = true

  const q = QUESTIONS.find(qq => qq.id === questionId)
  if (!q) return
  const isCorrect = q.options.find(o => o.label === label)?.correct || false

  // 更新UI
  document.querySelectorAll('#challenge-options .option-card').forEach(card => {
    const optLabel = card.querySelector('.option-label').textContent.trim()
    if (q.options.find(o => o.label === optLabel)?.correct) {
      card.classList.add('correct')
    }
    if (optLabel === label && !isCorrect) {
      card.classList.add('wrong')
    }
  })

  // 记录
  challengeState.answers.push({ questionId, correct: isCorrect })
  if (isCorrect) challengeState.correct++

  // 记录答题
  saveRecord({
    questionId: q.id,
    chosenOption: label,
    isCorrect,
    time: new Date().toISOString()
  })

  // 挑战是否结束
  if (challengeState.index + 1 >= challengeState.questions.length) {
    setTimeout(() => {
      challengeState.finished = true
      challengeState.passed = challengeState.correct >= 8
      renderChallenge()
    }, 1200)
  } else {
    setTimeout(() => {
      challengeState.index++
      challengeSelected = null
      challengeShowResult = false
      renderChallenge()
    }, 800)
  }
}

function renderChallengeResult(container) {
  const st = challengeState
  const profile = getUserProfile()
  if (!profile) return

  if (st.passed) {
    // 升级
    const newLevel = profile.level + 1
    const newLevelDef = getLevelDef(newLevel)
    profile.level = newLevel
    profile.levelName = newLevelDef.name
    profile.promotion = {
      eligible: false,
      lastChallengeTime: new Date().toISOString(),
      challengeCount: (profile.promotion?.challengeCount || 0) + 1,
      cooldownUntil: null
    }
    saveUserProfile(profile)

    container.innerHTML = `
      <div class="challenge-result passed">
        <div class="result-header" style="--level-color: ${getLevelColor(newLevel)}">
          <div class="result-icon level-up-anim">${getLevelIcon(newLevel)}</div>
          <div class="result-level">恭喜升级！</div>
          <div class="result-score">${newLevelDef.name}</div>
          <div class="result-desc">答对 ${st.correct}/10 题</div>
        </div>
        <div class="card">
          <div class="section-title">挑战详情</div>
          ${st.answers.map((a, i) => {
            const q = QUESTIONS.find(qq => qq.id === a.questionId)
            return `<div class="challenge-detail-item">
              <span class="challenge-num">${i + 1}</span>
              <span class="challenge-result-icon ${a.correct ? 'text-success' : 'text-danger'}">${a.correct ? '✓' : '✗'}</span>
              <span class="challenge-stem">${q ? q.stem.slice(0, 30) + '...' : ''}</span>
            </div>`
          }).join('')}
        </div>
        <div class="next-btn" onclick="challengeState=null;showPage('home');refreshHome()">返回首页</div>
      </div>
    `
  } else {
    // 失败
    const cooldown = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    profile.promotion = {
      eligible: false,
      lastChallengeTime: new Date().toISOString(),
      challengeCount: (profile.promotion?.challengeCount || 0) + 1,
      cooldownUntil: cooldown
    }
    saveUserProfile(profile)

    container.innerHTML = `
      <div class="challenge-result failed">
        <div class="result-header" style="--level-color: var(--danger)">
          <div class="result-icon">${LEVEL_ICONS.target}</div>
          <div class="result-level">挑战失败</div>
          <div class="result-score">答对 ${st.correct}/10 题</div>
          <div class="result-desc">还差 ${8 - st.correct} 题就能通过，加油！</div>
        </div>
        <div class="card">
          <div class="section-title">错题解析</div>
          ${st.answers.filter(a => !a.correct).map(a => {
            const q = QUESTIONS.find(qq => qq.id === a.questionId)
            if (!q) return ''
            const correctOpt = q.options.find(o => o.correct)
            return `<div style="margin-bottom:16px">
              <div style="font-size:14px;font-weight:500;margin-bottom:6px">${q.stem.slice(0, 50)}...</div>
              <div style="font-size:13px;color:var(--success)">正确答案：${correctOpt?.label}. ${formatContent(correctOpt?.text)}</div>
              <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${formatContent(q.explanation)}</div>
            </div>`
          }).join('')}
        </div>
        <div class="card" style="text-align:center;color:var(--text-muted);font-size:13px">
          24小时后可以再次挑战
        </div>
        <div class="next-btn" onclick="challengeState=null;showPage('home');refreshHome()">返回首页</div>
      </div>
    `
  }
}
