import {
	Account,
	type Connection,
	type Password,
	type User,
} from '@prisma/client'
import { redirect } from '@remix-run/node'
import bcrypt from 'bcryptjs'
import { Authenticator } from 'remix-auth'
import { safeRedirect } from 'remix-utils/safe-redirect'
import { connectionSessionStorage, providers } from './connections.server.ts'
import { prisma } from './db.server.ts'
import { combineHeaders, downloadFile } from './misc.tsx'
import { type ProviderUser } from './providers/provider.ts'
import { authSessionStorage } from './session.server.ts'

export const SESSION_EXPIRATION_TIME = 1000 * 60 * 60 * 24 * 30
export const getSessionExpirationDate = () =>
	new Date(Date.now() + SESSION_EXPIRATION_TIME)

export const sessionKey = 'sessionId'

export const authenticator = new Authenticator<ProviderUser>(
	connectionSessionStorage,
)

for (const [providerName, provider] of Object.entries(providers)) {
	authenticator.use(provider.getAuthStrategy(), providerName)
}

export async function getAccountId(request: Request) {
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const sessionId = authSession.get(sessionKey)
	if (!sessionId) return null
	const session = await prisma.session.findUnique({
		select: {
			activeAccountId: true,
			accounts: { select: { id: true } },
		},
		where: { id: sessionId, expirationDate: { gt: new Date() } },
	})

	const account = session?.accounts.find(
		({ id }) => id === session.activeAccountId,
	)

	if (!account) {
		throw redirect('/', {
			headers: {
				'set-cookie': await authSessionStorage.destroySession(authSession),
			},
		})
	}
	return account.id
}

export async function requireAccountId(
	request: Request,
	{ redirectTo }: { redirectTo?: string | null } = {},
) {
	const accountId = await getAccountId(request)
	if (!accountId) {
		const requestUrl = new URL(request.url)
		redirectTo =
			redirectTo === null
				? null
				: redirectTo ?? `${requestUrl.pathname}${requestUrl.search}`
		const loginParams = redirectTo ? new URLSearchParams({ redirectTo }) : null
		const loginRedirect = ['/login', loginParams?.toString()]
			.filter(Boolean)
			.join('?')
		throw redirect(loginRedirect)
	}
	return accountId
}

export async function requireAnonymous(request: Request) {
	const userId = await getAccountId(request)
	if (userId) {
		throw redirect('/')
	}
}

export async function login({
	username,
	password,
}: {
	username: Account['username']
	password: string
}) {
	const account = await verifyAccountPassword({ username }, password)
	if (!account) return null
	const session = await prisma.session.create({
		select: {
			id: true,
			expirationDate: true,
			accounts: true,
			activeAccountId: true,
		},
		data: {
			expirationDate: getSessionExpirationDate(),
			activeAccountId: account.id,
			accounts: { connect: { id: account.id } },
		},
	})
	return session
}

export async function resetAccountPassword({
	username,
	password,
}: {
	username: Account['username']
	password: string
}) {
	const hashedPassword = await getPasswordHash(password)
	return prisma.account.update({
		where: { username },
		data: {
			password: {
				update: {
					hash: hashedPassword,
				},
			},
		},
	})
}

export async function signup({
	email,
	username,
	password,
	name,
}: {
	email: Account['email']
	username: Account['username']
	name: User['name']
	password: string
}) {
	const hashedPassword = await getPasswordHash(password)

	const session = await prisma.session.create({
		data: {
			expirationDate: getSessionExpirationDate(),
			accounts: {
				create: {
					email: email.toLowerCase(),
					username: username.toLowerCase(),
					password: {
						create: {
							hash: hashedPassword,
						},
					},
					users: {
						create: {
							name,
							memberships: {
								create: {
									organizationId: 'default',
									roles: { connect: { name: 'user' } },
								},
							},
						},
					},
				},
			},
		},
		select: { id: true, expirationDate: true },
	})

	return session
}

export async function signupWithConnection({
	email,
	username,
	name,
	providerId,
	providerName,
	imageUrl,
}: {
	email: Account['email']
	username: Account['username']
	name: User['name']
	providerId: Connection['providerId']
	providerName: Connection['providerName']
	imageUrl?: string
}) {
	const session = await prisma.session.create({
		data: {
			expirationDate: getSessionExpirationDate(),
			accounts: {
				create: {
					email: email.toLowerCase(),
					username: username.toLowerCase(),
					connections: { create: { providerId, providerName } },
					users: {
						create: {
							name,
							memberships: {
								create: {
									organizationId: 'default',
									roles: { connect: { name: 'user' } },
								},
							},
							image: imageUrl
								? { create: await downloadFile(imageUrl) }
								: undefined,
						},
					},
				},
			},
		},
		select: { id: true, expirationDate: true },
	})

	return session
}

// TODO: Add logout single account
export async function logout(
	{
		request,
		redirectTo = '/',
	}: {
		request: Request
		redirectTo?: string
	},
	responseInit?: ResponseInit,
) {
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const sessionId = authSession.get(sessionKey)
	// if this fails, we still need to delete the session from the user's browser
	// and it doesn't do any harm staying in the db anyway.
	if (sessionId) {
		// the .catch is important because that's what triggers the query.
		// learn more about PrismaPromise: https://www.prisma.io/docs/orm/reference/prisma-client-reference#prismapromise-behavior
		void prisma.session.deleteMany({ where: { id: sessionId } }).catch(() => {})
	}
	throw redirect(safeRedirect(redirectTo), {
		...responseInit,
		headers: combineHeaders(
			{ 'set-cookie': await authSessionStorage.destroySession(authSession) },
			responseInit?.headers,
		),
	})
}

export async function getPasswordHash(password: string) {
	const hash = await bcrypt.hash(password, 10)
	return hash
}

export async function verifyAccountPassword(
	where: Pick<Account, 'username'> | Pick<Account, 'id'>,
	password: Password['hash'],
) {
	const userWithPassword = await prisma.account.findUnique({
		where,
		select: { id: true, password: { select: { hash: true } } },
	})

	if (!userWithPassword || !userWithPassword.password) {
		return null
	}

	const isValid = await bcrypt.compare(password, userWithPassword.password.hash)

	if (!isValid) {
		return null
	}

	return { id: userWithPassword.id }
}
