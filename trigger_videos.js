const { generateBrindeForOrder } = require('./lib/brindeVideo')
const orders = [
  'e75f0d24-f36e-4ec8-ba1d-602d963d89f4', // Edijenaldo → Helen
  'bf701596-2404-4bf2-bdf2-11795733b105', // Claudia → filhos
]
;(async () => {
  for (const id of orders) {
    console.log('Gerando video p/', id.slice(0,8))
    await generateBrindeForOrder(id)
  }
  console.log('Done')
})()
