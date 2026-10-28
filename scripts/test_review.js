#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let clock = Date.UTC(2026, 7, 10, 12, 0, 0);
let persisted = {};
const clone = value => JSON.parse(JSON.stringify(value));
class TestDate extends Date { static now() { return clock; } }
const window = {
  SrsPolicy: require('../js/srs-policy'),
  Store: {
    getReview: () => clone(persisted),
    saveReview: value => { persisted = clone(value); },
  },
};

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'review.js'), 'utf8');
vm.runInNewContext(source, { window, Date: TestDate, console }, { filename: 'review.js' });
const Review = window.Review;
const intervals = Review.INTERVALS_MIN;
const word = { word: 'memory', meaning: '记忆', pos: 'n.' };
const other = { word: 'isolation', meaning: '隔离', pos: 'n.' };

function dueNow(lib, target, stage) {
  const key = Review.wordKey(target);
  persisted[lib].words[key].stage = stage;
  persisted[lib].words[key].due = clock;
}

const first = Review.rememberWord('cet4', word);
assert.equal(first.action, 'learn', '首次点击必须登记首轮学习');
assert.equal(first.item.stage, 0);
assert.equal(first.item.due, clock + intervals[0] * 60000);

const originalDue = first.item.due;
clock = originalDue;
const duplicate = Review.rememberWord('cet4', word);
assert.equal(duplicate.action, 'seen', '重复首轮事件只能视为重复同步');
assert.equal(duplicate.item.stage, 0, '重复首轮事件不能推进周期');
assert.equal(duplicate.item.due, originalDue, '重复首轮事件不能改写到期时间');

const failed = Review.reviewWord('cet4', word, false);
assert.equal(failed.action, 'forgot');
assert.equal(failed.item.stage, 0, '没记住应回到第一周期');
assert.equal(failed.item.failCount, 1);
assert.equal(failed.item.due, clock + intervals[0] * 60000);

const earlyDue = failed.item.due;
const early = Review.reviewWord('cet4', word, true);
assert.equal(early.action, 'early', '未到期不得提前推进');
assert.equal(early.item.due, earlyDue);

for (let expectedStage = 1; expectedStage <= intervals.length; expectedStage++) {
  clock = Review.getWord('cet4', word).due;
  const passed = Review.reviewWord('cet4', word, true);
  assert.equal(passed.item.stage, expectedStage, `第 ${expectedStage} 次通过应推进一档`);
  if (expectedStage < intervals.length) {
    assert.equal(passed.action, 'review');
    assert.equal(passed.item.due, clock + intervals[expectedStage] * 60000);
  } else {
    assert.equal(passed.action, 'mastered');
    assert.equal(passed.item.due, null, '全部周期完成后不应再排期');
  }
}

const mastered = Review.reviewWord('cet4', word, false);
assert.equal(mastered.action, 'mastered', '已巩固词不能被误重置');
assert.equal(Review.stats('cet4').done, 1);
assert.equal(Review.stats('cet4').failures, 1);

Review.rememberWord('cet6', other);
assert.equal(Review.stats('cet4').total, 1, '不同词库记录必须隔离');
assert.equal(Review.stats('cet6').total, 1, '不同词库应有独立记录');
assert.equal(Review.dueWords('cet6').length, 0);
clock = Review.getWord('cet6', other).due;
assert.equal(Review.dueWords('cet6').length, 1, '到期查询必须按当前时间生效');
assert.equal(Review.soonestDue('cet6'), clock);

assert.equal(Review.reviewWord('cet4', { word: 'missing', meaning: '不存在' }, true).action, 'missing');
console.log(`PASS review lifecycle (${intervals.length} intervals, fail/reset, duplicate, early, mastered, library isolation)`);
