/** True for a GTIN-8/12/13/14 with a valid check digit. */
export function isGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false
  const digits = code.split('').map(Number)
  const check = digits.pop()!
  let sum = 0
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1) })
  return (10 - (sum % 10)) % 10 === check
}
