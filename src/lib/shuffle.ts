// =============================================================================
// シード付き乱数シャッフル（一覧の sort=random / 回答画面の前後移動で共有）
//   同じ seed なら常に同じ並びを再現する必要がある（実装計画・要件定義書 4.1）。
//   質問一覧（Stage 3a）と回答画面の前後移動（Stage 4）は、どちらも
//   「フィルタ後の質問配列（id昇順）」に対してこの関数を適用することで、
//   同じ seed から常に同じ並びを得られる。
// =============================================================================

/** 32bit Mulberry32 PRNG。同じ seed からは常に同じ乱数列を生成する（決定的）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * seed 付き Fisher-Yates シャッフル。元配列は変更せず新しい配列を返す。
 * 呼び出し側は毎回同じ入力順（例: id昇順）の配列を渡すこと。入力順が変われば
 * 同じ seed でも結果が変わってしまうため。
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  const random = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * sort=random が選ばれたが seed 未指定のときに使う、新規ランダムseedの生成。
 * 呼び出し側（page.tsx）がURLへ付与してリダイレクトし、以降はそのseedを
 * 使い回すことで並びを固定する。
 */
export function generateRandomSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}
