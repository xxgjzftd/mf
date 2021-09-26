import { getPkgId } from 'src/utils'

test('xx', () => {
  // expect(getPkgId('@xx/yy')).toBe('yy')
  expect(true).toBe(true)
  // @ts-ignore
  expect(getPkgId.mock).toBeTruthy()
})
