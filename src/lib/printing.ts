import type { Sale, ShopSettings } from '../types'

type SerialPortLike = {
  open(options: { baudRate: number }): Promise<void>
  writable: WritableStream<Uint8Array> | null
}

type SerialApi = { requestPort(): Promise<SerialPortLike> }
type UsbEndpoint = { direction: string; endpointNumber: number }
type UsbAlternate = { interfaceClass: number; endpoints: UsbEndpoint[] }
type UsbInterface = { interfaceNumber: number; alternates: UsbAlternate[] }
type UsbDeviceLike = {
  configuration: { interfaces: UsbInterface[] } | null
  open(): Promise<void>
  selectConfiguration(configuration: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  transferOut(endpointNumber: number, data: BufferSource): Promise<unknown>
}
type UsbApi = { requestDevice(options: { filters: Array<{ classCode: number }> }): Promise<UsbDeviceLike> }
type NavigatorWithPrinters = Navigator & { serial?: SerialApi; usb?: UsbApi }

let serialPort: SerialPortLike | null = null
let usbPrinter: { device: UsbDeviceLike; endpoint: number } | null = null

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

export async function connectThermalPrinter(): Promise<string> {
  const printerApi = navigator as NavigatorWithPrinters
  if (printerApi.serial) {
    serialPort = await printerApi.serial.requestPort()
    await serialPort.open({ baudRate: 9600 })
    usbPrinter = null
    return 'Impressora serial conectada.'
  }
  if (printerApi.usb) {
    const device = await printerApi.usb.requestDevice({ filters: [{ classCode: 7 }] })
    await device.open()
    if (!device.configuration) await device.selectConfiguration(1)
    const printerInterface = device.configuration?.interfaces.find(item => item.alternates.some(alt => alt.interfaceClass === 7))
    const endpoint = printerInterface?.alternates.flatMap(item => item.endpoints).find(item => item.direction === 'out')
    if (!printerInterface || !endpoint) throw new Error('A impressora USB não oferece uma interface ESC/POS compatível.')
    await device.claimInterface(printerInterface.interfaceNumber)
    usbPrinter = { device, endpoint: endpoint.endpointNumber }
    serialPort = null
    return 'Impressora USB conectada.'
  }
  throw new Error('Este navegador não oferece Web Serial ou WebUSB. Use a impressão do navegador.')
}

export function prepareReceiptPrint(): Window | null {
  if (serialPort || usbPrinter) return null
  return window.open('', '_blank', 'width=400,height=600')
}

export function receiptHtml(sale: Sale, settings: ShopSettings, companyName: string) {
  const width = settings.largura_papel_mm
  const rows = sale.itens.map(item => `<tr><td>${escapeHtml(`${item.quantidade}x ${item.nome}`)}</td><td>${money(item.subtotal)}</td></tr>`).join('')
  const logo = settings.logotipo_url
    ? `<img class="logo" src="${escapeHtml(settings.logotipo_url)}" alt="">`
    : ''
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Comprovante</title><style>
    @page{size:${width}mm auto;margin:3mm}body{font:12px monospace;width:${width === 58 ? '52mm' : '72mm'};margin:0 auto;color:#111}
    h2,p{text-align:center;margin:5px 0}.logo{display:block;max-width:30mm;max-height:18mm;margin:0 auto 5px}
    table{width:100%;border-collapse:collapse}td{padding:3px 0;vertical-align:top}td:last-child{text-align:right;white-space:nowrap}
    .line{border-top:1px dashed #111;margin:7px 0}.total{font-weight:bold;font-size:15px;text-align:right}
  </style>${logo}<h2>${escapeHtml(companyName)}</h2><p>${escapeHtml(settings.cabecalho_nota)}</p>
  <p>Comprovante de venda</p><p>${new Date(sale.data_hora).toLocaleString('pt-BR')}</p>
  <div class="line"></div><table>${rows}</table><div class="line"></div><p class="total">TOTAL ${money(sale.valor_total)}</p>
  <p>Pagamento: ${escapeHtml(sale.forma_pagamento)}</p>${sale.forma_pagamento === 'Dinheiro' ? `<p>Troco: ${money(sale.troco)}</p>` : ''}
  <div class="line"></div><p>${escapeHtml(settings.rodape_nota)}</p></html>`
}

function escPosText(sale: Sale, settings: ShopSettings, companyName: string): Uint8Array {
  const plain = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u00a0\u202f]/g, ' ')
  const text = [
    companyName,
    settings.cabecalho_nota,
    '-'.repeat(settings.largura_papel_mm === 58 ? 30 : 42),
    ...sale.itens.map(item => `${item.quantidade}x ${item.nome}\n${money(item.subtotal)}`),
    '-'.repeat(settings.largura_papel_mm === 58 ? 30 : 42),
    `TOTAL ${money(sale.valor_total)}`,
    `Pagamento: ${sale.forma_pagamento}`,
    ...(sale.forma_pagamento === 'Dinheiro' ? [`Troco: ${money(sale.troco)}`] : []),
    new Date(sale.data_hora).toLocaleString('pt-BR'),
    settings.rodape_nota,
    '',
    '',
    ''
  ].filter(Boolean).map(plain).join('\n')
  const content = new TextEncoder().encode(text)
  const output = new Uint8Array(content.length + 5)
  output.set([0x1b, 0x40], 0)
  output.set(content, 2)
  output.set([0x1d, 0x56, 0x00], content.length + 2)
  return output
}

export async function printReceipt(sale: Sale, settings: ShopSettings, companyName: string, preparedWindow?: Window | null) {
  const payload = escPosText(sale, settings, companyName)
  if (serialPort?.writable) {
    const writer = serialPort.writable.getWriter()
    try { await writer.write(payload) } finally { writer.releaseLock() }
    return
  }
  if (usbPrinter) {
    await usbPrinter.device.transferOut(usbPrinter.endpoint, payload)
    return
  }

  const popup = preparedWindow ?? window.open('', '_blank', 'width=400,height=600')
  if (!popup) throw new Error('Permita a abertura de janelas para imprimir o comprovante.')
  popup.document.open()
  popup.document.write(receiptHtml(sale, settings, companyName))
  popup.document.close()
  popup.focus()
  popup.print()
}
