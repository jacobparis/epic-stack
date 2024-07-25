import { redirect, type LoaderFunctionArgs } from '@remix-run/node'
import { requireAccountId, logout } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	const accountId = await requireAccountId(request)
	const account = await prisma.account.findUnique({ where: { id: accountId } })
	if (!account) {
		const requestUrl = new URL(request.url)
		const loginParams = new URLSearchParams([
			['redirectTo', `${requestUrl.pathname}${requestUrl.search}`],
		])
		const redirectTo = `/login?${loginParams}`
		await logout({ request, redirectTo })
		return redirect(redirectTo)
	}
	return redirect(`/users/${account.username}`)
}
