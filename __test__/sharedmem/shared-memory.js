const SharedMap = require('sharedmap')

const MAPSIZE = 2048 * 56
// Size is in UTF-16 codepointse
const KEYSIZE = 32
const OBJSIZE = 4056

const m = new SharedMap(MAPSIZE, KEYSIZE, OBJSIZE)

m.set('key', 'val')
m.set('key2', 'val2')
console.log(m.length)

console.log(m.map(v => v))
