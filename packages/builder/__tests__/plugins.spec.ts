// import { entry, routes } from '@plugins'
import { getPkgId } from 'src/utils'

test('xx', () => {
  expect(getPkgId('@xx/yy')).toBe('yy')
})
