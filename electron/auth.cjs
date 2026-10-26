const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto')
const { promisify } = require('node:util')
const { z } = require('zod')

const scrypt = promisify(scryptCallback)
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const passwordSchema = z.string().min(8).max(128)
const usernameSchema = z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/)
const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  username: usernameSchema,
  password: passwordSchema,
}).strict()
const loginSchema = z.object({ username: usernameSchema, password: passwordSchema }).strict()
const dummySalt = Buffer.from('42'.repeat(16), 'hex')
const dummyHash = Buffer.alloc(64, 0xa5)

function publicUser(user) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    username: user.username,
    role: user.role,
    permissions: typeof user.permissions === 'string' ? JSON.parse(user.permissions) : (user.permissions ?? []),
  }
}

function createAuthenticator(database, {
  now = Date.now,
  sessionTtl = 30 * 60_000,
  failuresBeforeLock = 5,
  lockDuration = 60_000,
} = {}) {
  const sessions = new Map()
  const failures = new Map()

  async function derive(password, salt) {
    return Buffer.from(await scrypt(password, salt, 64, scryptOptions))
  }

  function createSession(user) {
    const token = randomBytes(32).toString('base64url')
    const safeUser = publicUser(user)
    sessions.set(token, { user: safeUser, lastSeen: now() })
    return { sessionToken: token, user: safeUser }
  }

  function requireSession(token, permission) {
    const current = sessions.get(token)
    if (!current || now() - current.lastSeen >= sessionTtl) {
      if (current) sessions.delete(token)
      throw new Error('Sitzung abgelaufen. Bitte erneut anmelden.')
    }
    const required = Array.isArray(permission) ? permission : [permission]
    if (!required.every((entry) => entry === 'session' || current.user.role === 'admin' || current.user.permissions.includes(entry)))
      throw new Error('Fuer diese Aktion fehlt die erforderliche Benutzerrolle.')
    current.lastSeen = now()
    return current.user
  }

  return {
    async state(token) {
      const setupRequired = (await database('userCount')) === 0
      if (setupRequired) return { setupRequired: true, user: null }
      try {
        return {
          setupRequired: false,
          user: token ? requireSession(token, 'session') : null,
        }
      } catch {
        return { setupRequired: false, user: null }
      }
    },
    async bootstrap(payload) {
      if ((await database('userCount')) !== 0)
        throw new Error('Admin account is already configured.')
      const parsed = profileSchema.parse(payload)
      const salt = randomBytes(16)
      const passwordHash = await derive(parsed.password, salt)
      const user = await database('createInitialAdmin', {
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        email: parsed.email.toLowerCase(),
        username: parsed.username.toLowerCase(),
        salt: salt.toString('hex'),
        passwordHash: passwordHash.toString('hex'),
      })
      return createSession(user)
    },
    async login(payload) {
      const parsed = loginSchema.safeParse(payload)
      if (!parsed.success)
        throw new Error('Benutzername oder Passwort ist falsch oder Konto gesperrt.')
      const username = parsed.data.username.toLowerCase()
      const gate = failures.get(username)
      if (gate?.lockedUntil > now())
        throw new Error('Benutzername oder Passwort ist falsch oder Konto gesperrt.')

      const user = await database('findUserByUsername', username)
      const salt = user ? Buffer.from(user.salt, 'hex') : dummySalt
      const expected = user ? Buffer.from(user.passwordHash, 'hex') : dummyHash
      const candidate = await derive(parsed.data.password, salt)
      const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected)
      if (!user || !user.active || !matches) {
        const count = (gate?.count ?? 0) + 1
        failures.set(username, {
          count,
          lockedUntil: count >= failuresBeforeLock ? now() + lockDuration : 0,
        })
        throw new Error('Benutzername oder Passwort ist falsch oder Konto gesperrt.')
      }
      const latestUser = await database('findUserByUsername', username)
      if (!latestUser || !latestUser.active || latestUser.id !== user.id || latestUser.passwordHash !== user.passwordHash)
        throw new Error('Benutzername oder Passwort ist falsch oder Konto gesperrt.')
      failures.delete(username)
      await database('recordLogin', user.id)
      return createSession(latestUser)
    },
    // Development only: Main calls this exclusively for unpackaged apps started with --dev.
    // Signs in the given user, or the first active admin, without a password.
    async developmentLogin(username) {
      const users = await database('listUsers')
      const candidate = username
        ? users.find((user) => user.username === String(username).trim().toLowerCase())
        : users.find((user) => user.role === 'admin')
      const user = candidate && await database('findUserByUsername', candidate.username)
      if (!user || !user.active) throw new Error(username ? `Entwicklungs-Login: Benutzer ${username} nicht gefunden.` : 'Entwicklungs-Login: Kein aktiver Admin vorhanden.')
      await database('recordLogin', user.id)
      return createSession(user)
    },
    logout(token) {
      sessions.delete(token)
      return true
    },
    async listUsers(token) {
      requireSession(token, 'users')
      return database('listUsers')
    },
    async saveUser(token, payload) {
      const actor = requireSession(token, 'session')
      if (actor.role !== 'admin') throw new Error('Nur Administratoren duerfen Benutzer verwalten.')
      const parsed = profileSchema.omit({ password: true }).extend({
        id: z.string().uuid().optional(), role: z.enum(['admin', 'employee']),
        permissions: z.array(z.enum(['dashboard', 'products', 'orders', 'customers', 'settings', 'users', 'shop', 'taxonomies', 'sync', 'history', 'plugins', 'media'])).max(12),
        password: passwordSchema.optional(),
      }).strict().parse(payload)
      const { password, ...profile } = parsed
      let passwordData = {}
      if (password) {
        const salt = randomBytes(16)
        passwordData = { salt: salt.toString('hex'), passwordHash: (await derive(password, salt)).toString('hex') }
      }
      if (!parsed.id && !password) throw new Error('Ein Startpasswort ist erforderlich.')
      const id = await database('saveUser', { ...profile, ...passwordData })
      for (const [token, session] of sessions) if (session.user.id === id) sessions.delete(token)
      return id
    },
    async deleteUser(token, id) {
      const actor = requireSession(token, 'session')
      if (actor.role !== 'admin') throw new Error('Nur Administratoren duerfen Benutzer verwalten.')
      const result = await database('deleteUser', id)
      for (const [token, session] of sessions) if (session.user.id === id) sessions.delete(token)
      return result
    },
    requireSession,
  }
}

module.exports = { createAuthenticator }
