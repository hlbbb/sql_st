// ============================================
// Supabase 配置
// 填入你的 Supabase 项目 URL 和 anon key
// ============================================
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co'
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY'

// 初始化客户端
let supabaseClient = null

function initSupabase() {
  if (typeof supabase !== 'undefined' && supabase.createClient) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    return true
  }
  return false
}

// ============================================
// 用户认证（匿名登录 + 微信登录预留）
// ============================================
async function ensureUser() {
  if (!supabaseClient) return null

  // 检查本地缓存
  const cachedUserId = localStorage.getItem('sb_user_id')
  if (cachedUserId) return cachedUserId

  // 匿名登录
  const { data, error } = await supabaseClient.auth.signInAnonymously()
  if (error) {
    console.error('匿名登录失败:', error)
    return null
  }

  const userId = data.user.id
  localStorage.setItem('sb_user_id', userId)

  // 创建用户记录
  await supabaseClient.from('users').upsert({
    id: userId,
    nickname: 'SQL学习者',
    avatar_url: ''
  }, { onConflict: 'id' })

  return userId
}

// ============================================
// 题目相关
// ============================================
async function fetchQuestions({ difficulty, category, keyword, page = 1, pageSize = 50 }) {
  if (!supabaseClient) return null

  let query = supabaseClient
    .from('questions')
    .select('*', { count: 'exact' })
    .order('category', { ascending: true })
    .order('difficulty', { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (difficulty) query = query.eq('difficulty', difficulty)
  if (category) query = query.eq('category', category)
  if (keyword) {
    query = query.or(`stem.ilike.%${keyword}%,tags.cs.["${keyword}"]`)
  }

  const { data, error, count } = await query
  if (error) { console.error('fetchQuestions error:', error); return null }
  return { data, total: count }
}

async function fetchQuestionById(id) {
  if (!supabaseClient) return null
  const { data, error } = await supabaseClient.from('questions').select('*').eq('id', id).single()
  if (error) { console.error('fetchQuestionById error:', error); return null }
  return data
}

async function fetchRandomQuestions(count = 20) {
  if (!supabaseClient) return null
  // PostgreSQL random
  const { data, error } = await supabaseClient
    .from('questions')
    .select('*')
    .limit(count)
    .order('id', { referencedTable: 'questions', ascending: false })
  if (error) { console.error('fetchRandomQuestions error:', error); return null }
  return shuffleArray(data)
}

async function searchQuestions(keyword) {
  if (!supabaseClient) return null
  const { data, error } = await supabaseClient
    .from('questions')
    .select('*')
    .or(`stem.ilike.%${keyword}%,tags.cs.["${keyword}"]`)
    .limit(50)
  if (error) { console.error('searchQuestions error:', error); return null }
  return data
}

// ============================================
// 答题记录
// ============================================
async function submitAnswerRemote(questionId, chosenOption, isCorrect) {
  if (!supabaseClient) return false
  const userId = await ensureUser()
  if (!userId) return false

  const { error } = await supabaseClient.from('answer_records').insert({
    user_id: userId,
    question_id: questionId,
    chosen_option: chosenOption,
    is_correct: isCorrect
  })
  if (error) { console.error('submitAnswer error:', error); return false }

  // 更新错题本
  if (!isCorrect) {
    await supabaseClient.from('wrong_book').upsert({
      user_id: userId,
      question_id: questionId,
      reviewed: false
    }, { onConflict: 'user_id,question_id', ignoreDuplicates: true })
  } else {
    await supabaseClient.from('wrong_book')
      .update({ reviewed: true })
      .eq('user_id', userId)
      .eq('question_id', questionId)
  }

  return true
}

// ============================================
// 错题本
// ============================================
async function fetchWrongBook(page = 1, pageSize = 50) {
  if (!supabaseClient) return []
  const userId = await ensureUser()
  if (!userId) return []

  const { data, error } = await supabaseClient
    .from('wrong_book')
    .select('question_id, reviewed, questions(*)')
    .eq('user_id', userId)
    .eq('reviewed', false)
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (error) { console.error('fetchWrongBook error:', error); return [] }
  return data
}

async function removeFromWrongBookRemote(questionId) {
  if (!supabaseClient) return false
  const userId = await ensureUser()
  if (!userId) return false

  const { error } = await supabaseClient.from('wrong_book')
    .update({ reviewed: true })
    .eq('user_id', userId)
    .eq('question_id', questionId)
  return !error
}

// ============================================
// 统计
// ============================================
async function fetchUserStats() {
  if (!supabaseClient) return null
  const userId = await ensureUser()
  if (!userId) return null

  const { data, error } = await supabaseClient
    .from('user_stats')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error) { console.error('fetchUserStats error:', error); return null }
  return data
}

// ============================================
// 排行榜
// ============================================
async function fetchLeaderboard() {
  if (!supabaseClient) return []
  const { data, error } = await supabaseClient
    .from('leaderboard')
    .select('*')
    .limit(50)
  if (error) { console.error('fetchLeaderboard error:', error); return [] }
  return data
}

// ============================================
// 数据导入工具（批量插入题目）
// ============================================
async function importQuestions(questions) {
  if (!supabaseClient) return { success: 0, fail: 0 }
  const batchSize = 20
  let success = 0, fail = 0

  for (let i = 0; i < questions.length; i += batchSize) {
    const batch = questions.slice(i, i + batchSize).map(q => ({
      type: q.type,
      difficulty: q.difficulty,
      category: q.category,
      tags: JSON.stringify(q.tags || []),
      stem: q.stem,
      options: JSON.stringify(q.options),
      explanation: q.explanation
    }))

    const { error } = await supabaseClient.from('questions').insert(batch)
    if (error) { fail += batch.length; console.error('import batch error:', error) }
    else { success += batch.length }
  }

  return { success, fail }
}
