/**
 * 自测用的极简断言。
 *
 * 这些测试原本只打印 PASS/FAIL，退出码永远是 0 —— 挂在 CI 上等于没有检查。
 * 这里把断言集中起来：任何一条失败都会让进程以 1 退出。
 */

let failures = 0
let checks = 0

/**
 * 断言一个布尔条件。
 * @param {boolean} condition - 期望为真的条件。
 * @param {string} label - 报告里显示的名字。
 * @param {unknown} [detail] - 失败时附带的现场信息。
 */
export function check(condition, label, detail) {
  checks += 1
  if (condition === true) {
    console.log(`PASS  ${label}`)
    return true
  }
  failures += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${String(detail)}`}`)
  return false
}

/**
 * 断言两个值相等（用 Object.is）。
 * @param {unknown} actual - 实际值。
 * @param {unknown} expected - 期望值。
 * @param {string} label - 报告里显示的名字。
 */
export function equal(actual, expected, label) {
  const ok = Object.is(actual, expected)
  return check(ok, label, ok ? undefined : `expected ${String(expected)}, got ${String(actual)}`)
}

/**
 * 打印汇总；有失败时结束进程。
 * 在顶层直接调用即可：任何 import 了这个模块的测试都会在最后走到它。
 * @returns {void}
 */
export function report() {
  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'}: ${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
}

// 顶层 await 结束时自动汇总，避免每个测试都手工调用。
process.on('beforeExit', () => {
  if (checks > 0 && failures > 0) process.exitCode = 1
})
