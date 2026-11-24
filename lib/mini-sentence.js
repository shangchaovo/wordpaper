'use strict';
const ai = require('./ai-model');
const { randomUUID } = require('node:crypto');

function gradingPrompt(word, meaning, text, language = '英语') {
  return [
    '你是' + language + '老师,学生在用单词「' + word + '」(' + (meaning || '') + ')造句子。',
    '请批改这句:' + text,
    '',
    '只回一个 JSON 对象,不要任何解释文字、不要 Markdown 代码块,格式:',
    '{"ok": true, "score": 1-5 的整数, "used": 学生是否真的用了这个词(true/false),',
    ' "fixed": "改好的自然' + language + '句子", "feedback": "一两句中文点评,指出问题并说怎么改",',
    ' "example": "再用这个词造一个新的' + language + '例句(不要和学生写的一样),中文翻译另起一行" }',
    '判断标准:语法是否正确、这个词用得是否地道、句子是否自然。如果学生用了别的形式(如复数/时态变化)也算 used=true。',
  ].join('\n');
}

function parseGrading(raw) {
  const text = String(raw || '');
  let parsed;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch {}
  if (!Number.isInteger(parsed?.score) || parsed.score < 1 || parsed.score > 5 || typeof parsed.used !== 'boolean' ||
      typeof parsed.feedback !== 'string' || !parsed.feedback.trim() || typeof parsed.fixed !== 'string') {
    throw ai.failure('invalid_grading', '模型返回的批改格式不完整，请重试；本次未计入学习记录。', 502);
  }
  return parsed;
}

function createMiniSentence({ storage, learning, allowPrivate = false, complete = ai.complete }) {
  const pending = new Map();
  async function grade(userId, body, access) {
    const { id, eventId, text } = body;
    const owner = randomUUID();
    // A database lease coalesces requests reaching different server replicas.
    // It also lets another request resume if the first process exits mid-call.
    let claim = learning.claimSentence(userId, body, owner);
    const deadline = Date.now() + 50000;
    while (claim === 'pending' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      access.authorize?.();
      claim = learning.claimSentence(userId, body, owner);
    }
    if (claim === 'pending') throw ai.failure('sentence_pending', '上一次批改还在进行，请稍后重试。', 503);
    if (claim !== 'claimed') return claim;
    try {
      const entry = learning.word(userId, id);
      if (!entry) throw ai.failure('word_missing', '当前账号中找不到这条单词。', 404);
      const language = entry.library === 'french' ? '法语' : entry.library === 'spanish' ? '西班牙语' :
        entry.library.startsWith('jlpt_') ? '日语' : '英语';
      const config = storage.models.get(userId);
      const response = await complete(config, [
        { role: 'system', content: '你是' + language + '老师。严格按用户给定的 JSON 格式批改句子，不要添加 Markdown。' },
        { role: 'user', content: gradingPrompt(entry.word, entry.meaning, text, language) },
      ], { allowPrivate, maxTokens: 800 });
      access.authorize?.();
      const parsed = parseGrading(response.text);
      const result = { score: parsed.score, usedTarget: parsed.used, corrected: parsed.fixed.trim(),
        feedback: parsed.feedback.trim(), example: typeof parsed.example === 'string' ? parsed.example.trim() : '' };
      return learning.recordSentence(userId, body, result, owner, access.authorize);
    } catch (error) {
      learning.releaseSentence(userId, eventId, owner);
      throw error;
    }
  }
  async function submit(userId, body, access = {}) {
    const { id, eventId } = body || {};
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const saved = learning.getSentenceResult(userId, eventId, id, text);
    if (saved) return saved;
    const existing = pending.get(userId);
    if (existing) {
      if (existing.sessionId === access.sessionId && existing.eventId === eventId && existing.id === id && existing.text === text) return existing.promise;
      throw ai.failure('model_busy', '上一次批改还在进行，请稍后再试。', 429);
    }
    const promise = grade(userId, { ...body, text }, access);
    pending.set(userId, { eventId, id, text, promise, sessionId: access.sessionId });
    try { return await promise; } finally { pending.delete(userId); }
  }
  return { submit };
}

module.exports = { createMiniSentence, gradingPrompt, parseGrading };
