/** 发布闸门：额度、冷却、评分、风险。CLI 和 WebUI 都走这里，不要在别处另写一套。 */
export function check(cfg, state, result, bvid) {
  const g = cfg.guard ?? {}
  const problems = []

  if (!result) {
    problems.push('没有生成结果')
  } else {
    if (typeof result.score === 'number' && result.score < (g.minScore ?? 13)) {
      problems.push(`评分 ${result.score} 低于门槛 ${g.minScore ?? 13}`)
    }
    if (result.verdict === '不发') problems.push('模型判断不发')
    if (result.risk && result.risk !== '无') problems.push(`风险：${result.risk}`)
  }

  const used = state.sharedToday ?? 0
  const max = g.maxSharePerDay ?? 3
  if (used >= max) problems.push(`今日额度已用完（${used}/${max}）`)

  const last = state.seen?.[bvid]
  if (last) {
    const days = (Date.now() - new Date(last).getTime()) / 86_400_000
    const cd = g.sameVideoCooldownDays ?? 7
    if (days < cd) problems.push(`这条 ${days.toFixed(1)} 天前发过（冷却 ${cd} 天）`)
  }

  return problems
}
