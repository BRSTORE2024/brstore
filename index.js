import fs from 'fs'
import pino from 'pino'
import chalk from 'chalk'
import readline from 'readline'
import { Boom } from '@hapi/boom'
import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))

const logger = pino({ level: 'silent' })

const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('session')
	const { version } = await fetchLatestBaileysVersion()
	console.log(`Using WA v${version.join('.')}`)

	const sock = makeWASocket({
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
	
	const pendingPwInput = new Map() // <sender, emailList[]>

	sock.ev.on('messages.upsert', async ({ messages, type }) => {
		if (type !== 'notify') return
		const msg = messages[0]
		console.log(msg)
		if (!msg.message || msg.key.fromMe) return

		const sender = msg.key.remoteJid
		const text = (msg.message?.conversation ||
			msg.message?.extendedTextMessage?.text ||
			'').trim()

		const prefix = '!sortpw'

		// ⏳ Cek apakah user sedang dalam sesi password
		if (pendingPwInput.has(sender)) {
			const emailList = pendingPwInput.get(sender)
			const password = text.trim()

			// Hapus sesi
			pendingPwInput.delete(sender)

			// Gabungkan email + pw
			const result = emailList
				.sort((a, b) => a.localeCompare(b))
				.map((email, i) => `${i + 1}. ${email} | ${password}`)
				.join('\n')

			await sock.sendMessage(sender, {
				text: `✅ Berikut hasil sortir:\n${result}`
			}, { quoted: msg })

			return
		}

			// 🟡 Trigger awal: !sortpw + daftar email
		if (text.toLowerCase().startsWith(prefix)) {
			const rawEmails = text.slice(prefix.length).trim().split('\n').map(e => e.trim())
			const regex = /^[\w.%+-]+@gmail\.com$/i
			const filtered = rawEmails.filter(e => regex.test(e))

			if (filtered.length === 0) {
				await sock.sendMessage(sender, {
					text: '❌ Tidak ditemukan email Gmail yang valid.'
				}, { quoted: msg })
				return
			}

			// Simpan ke map dan minta password
			pendingPwInput.set(sender, filtered)

			await sock.sendMessage(sender, {
				text: `📨 ${filtered.length} email ditemukan:\n${filtered.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nSilakan kirim *1 password* untuk semua email di atas.`
			}, { quoted: msg })

			return
		}
	})
	
}

setTimeout(() => startSock(), 3000)