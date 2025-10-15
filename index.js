import fs from 'fs'
import pino from 'pino'
import chalk from 'chalk'
import readline from 'readline'
import { Boom } from '@hapi/boom'
import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))

const logger = pino({ level: 'silent' })

const JADWAL_FILE = 'jadwal.json'
let schedule = fs.existsSync(JADWAL_FILE) ? JSON.parse(fs.readFileSync(JADWAL_FILE)) : {}

function saveSchedule() {
	fs.writeFileSync(JADWAL_FILE, JSON.stringify(schedule, null, 2))
}

let sock // global socket instance

const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('session')
	const { version } = await fetchLatestBaileysVersion()
	console.log(`Using WA v${version.join('.')}`)

	sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: false,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger)
		}
	})

	if (!sock.authState.creds.registered) {
		console.clear()
		let phoneNumber = await question(chalk.bgBlack(chalk.greenBright('Masukkan Nomor WhatsApo:\n')))
		phoneNumber = phoneNumber.replace(/[^0-9]/g, '') || ''
		if (phoneNumber.startsWith('0')) phoneNumber = phoneNumber.replace('0', '62')
		try {
			let code = await sock.requestPairingCode(phoneNumber)
			code = code?.match(/.{1,4}/g)?.join?.('-') || null
			console.log(chalk.black(chalk.bgGreen('Pairing Code:')), chalk.black(chalk.white(code)))
			rl.close()
		} catch (e) {
			throw new Error(e)
		}
	}

	sock.ev.on('creds.update', saveCreds)
	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect } = update

		if (connection === 'close') {
			const reason = new Boom(lastDisconnect?.error)?.output?.statusCode

			console.log(chalk.redBright(`Connection closed: ${connection}`))
			switch (reason) {
				case DisconnectReason.badSession:
					console.log(chalk.redBright('Bad session file, delete session dan scan ulang.'))
					process.exit()
					break
				case DisconnectReason.connectionClosed:
					console.log(chalk.redBright('Koneksi terputus, menyambung ulang...'))
					startSock()
					break
				case DisconnectReason.connectionLost:
					console.log(chalk.redBright('Koneksi hilang dari server, menyambung ulang...'))
					startSock()
					break
				case DisconnectReason.loggedOut:
					console.log(chalk.redBright('Akun logout, hapus session dan scan ulang.'))
					process.exit()
					break
				case DisconnectReason.restartRequired:
					console.log(chalk.yellowBright('Restart dibutuhkan, memulai ulang...'))
					startSock()
					break
				case DisconnectReason.timedOut:
					console.log(chalk.redBright('Connection timeout, menyambung ulang...'))
					startSock()
					break
				default:
					console.log(chalk.redBright(`Koneksi terputus dengan alasan tidak diketahui: ${reason}`))
					startSock()
			}
		} else if (connection === 'open') {
			console.log(chalk.greenBright('Koneksi ke WhatsApp berhasil!'))
		}
	})

	const pendingPwInput = new Map()

	sock.ev.on('messages.upsert', async ({ messages, type }) => {
		if (type !== 'notify') return
		const msg = messages[0]
		if (!msg.message) return

		const sender = msg.key.remoteJid
		const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '').trim()

		const prefix = '!sortpw'

		// Fitur sortpw dari kamu sebelumnya
		if (pendingPwInput.has(sender)) {
			const emailList = pendingPwInput.get(sender)
			const password = text.trim()

			pendingPwInput.delete(sender)

			const result = emailList
				.sort((a, b) => a.localeCompare(b))
				.map((email) => `${email} | ${password}`)
				.join('\n')

			await sock.sendMessage(sender, {
				text: `${result}`
			}, { quoted: msg })

			return
		}

		if (text.toLowerCase().startsWith(prefix)) {
			const body = text.slice(prefix.length).trim()

			const extractEmails = (text) => {
				const regex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
				const found = text.match(regex) || []
				return [...new Set(found)] // hapus duplikat
			}

			const emailList = extractEmails(body)

			if (emailList.length === 0) {
				await sock.sendMessage(sender, {
					text: '❌ Tidak ditemukan email Gmail yang valid.'
				}, { quoted: msg })
				return
			}

			pendingPwInput.set(sender, emailList)

			await sock.sendMessage(sender, {
				text: `📨 ${emailList.length} email ditemukan:\n${emailList.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nSilakan kirim *1 password* untuk semua email di atas.`
			}, { quoted: msg })

			return
		}

		// ========== PERINTAH JADWAL ===========

		if (text.toLowerCase().startsWith('!jadwal')) {
			const body = text.slice('!jadwal'.length).trim()

			// Coba cocokkan dengan target jid opsional
			// Format contoh:
			// "08:00,12:00,18:00 -123456789@g.us Pesan..."
			// atau tanpa target jid: "08:00,12:00 Pesan..."
			const match = body.match(/^([\d:,]+)\s+([-\d]+@g\.us|\d+)?\s*(.+)/) || body.match(/^([\d:,]+)\s+(.+)/)

			if (!match) {
				await sock.sendMessage(sender, {
					text: '❌ Format salah. Contoh:\n\n!jadwal 08:00,12:00,18:00 -123456789@g.us Pesan\natau\n!jadwal 08:00,12:00 Pesan (chat ini)'
				}, { quoted: msg })
				return
			}

			let times, jid, messageText

			if (match.length === 4) {
				times = match[1].split(',').map(t => t.trim())
				jid = match[2] || sender
				messageText = match[3]
			} else {
				times = match[1].split(',').map(t => t.trim())
				jid = sender
				messageText = match[2]
			}

			// Validasi jam
			const validTime = times.every(t => /^\d{1,2}:\d{2}$/.test(t))
			if (!validTime) {
				await sock.sendMessage(sender, {
					text: '❌ Format jam salah, gunakan HH:MM (24 jam). Contoh: 08:00,12:30'
				}, { quoted: msg })
				return
			}

			if (!schedule[jid]) schedule[jid] = []

			times.forEach(time => {
				schedule[jid].push({ time, message: messageText, lastSent: null })
			})

			saveSchedule()

			await sock.sendMessage(sender, {
				text: `✅ Jadwal ditambahkan untuk jam: ${times.join(', ')}\nTarget: ${jid}\nPesan: ${messageText}`
			}, { quoted: msg })

			return
		}

		if (text.toLowerCase() === '!listjadwal') {
			const data = schedule[sender] || []
			if (data.length === 0) {
				await sock.sendMessage(sender, {
					text: '📭 Kamu belum punya jadwal.'
				}, { quoted: msg })
				return
			}

			const result = data.map((item, i) => `${i + 1}. ⏰ ${item.time} - ${item.message}`).join('\n')

			await sock.sendMessage(sender, {
				text: `📋 Jadwal kamu:\n${result}`
			}, { quoted: msg })
			return
		}

		if (text.toLowerCase().startsWith('!hapusjadwal')) {
			const time = text.slice('!hapusjadwal'.length).trim()

			if (!/^\d{1,2}:\d{2}$/.test(time)) {
				await sock.sendMessage(sender, {
					text: '❌ Format salah. Contoh:\n!hapusjadwal 07:00'
				}, { quoted: msg })
				return
			}

			if (!schedule[sender]) {
				await sock.sendMessage(sender, {
					text: '⚠️ Tidak ada jadwal untuk dihapus.'
				}, { quoted: msg })
				return
			}

			const before = schedule[sender].length
			schedule[sender] = schedule[sender].filter(j => j.time !== time)
			const after = schedule[sender].length

			if (before === after) {
				await sock.sendMessage(sender, {
					text: `⚠️ Tidak ditemukan jadwal di jam ${time}`
				}, { quoted: msg })
				return
			}

			saveSchedule()

			await sock.sendMessage(sender, {
				text: `✅ Jadwal pada jam ${time} telah dihapus.`
			}, { quoted: msg })

			return
		}
	})

	// Fungsi bantu parse waktu flexible
	function parseTime(t) {
		const parts = t.split(':')
		let hh = parts[0].padStart(2, '0')
		let mm = parts[1] ? parts[1].padStart(2, '0') : '00'

		const hNum = Number(hh)
		const mNum = Number(mm)

		if (isNaN(hNum) || isNaN(mNum)) return null
		if (hNum < 0 || hNum > 23) return null
		if (mNum < 0 || mNum > 59) return null

		return `${hh}:${mm}`
	}

	// Scheduler cek setiap menit
	setInterval(async () => {
		if (!sock || !sock.user) return

		const now = new Date()
		// Ambil jam dan menit sekarang dengan format HH:MM
		const currentTime = now.toTimeString().slice(0, 5) 

		for (const jid in schedule) {
			for (const item of schedule[jid]) {
			// Jika waktu sekarang sama dengan waktu jadwal
				if (item.time === currentTime) {
				// Cek supaya tidak kirim duplikat dalam menit yang sama
					if (item.lastSent === currentTime) continue

					try {
						await sock.sendMessage(jid, { text: item.message })
						item.lastSent = currentTime
						saveSchedule()
						console.log(`Pesan terkirim ke ${jid} pada ${currentTime}`)
					} catch (e) {
						console.error(`Gagal kirim pesan ke ${jid} pada ${currentTime}:`, e.message)
					}
				}
			}
		}
	}, 60 * 1000) // cek tiap 60 detik (1 menit)
}

setTimeout(() => startSock(), 3000)