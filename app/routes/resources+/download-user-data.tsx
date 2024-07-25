import { json, type LoaderFunctionArgs } from '@remix-run/node'
import { requireAccountId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { getDomainUrl } from '#app/utils/misc.tsx'

export async function loader({ request }: LoaderFunctionArgs) {
	const accountId = await requireAccountId(request)
	const account = await prisma.account.findUniqueOrThrow({
		where: { id: accountId },
		// this is one of the *few* instances where you can use "include" because
		// the goal is to literally get *everything*. Normally you should be
		// explicit with "select". We're using select for images because we don't
		// want to send back the entire blob of the image. We'll send a URL they can
		// use to download it instead.
		include: {
			users: {
				include: {
					memberships: true,
					image: {
						select: {
							id: true,
							createdAt: true,
							updatedAt: true,
							contentType: true,
						},
					},
					notes: {
						include: {
							images: {
								select: {
									id: true,
									createdAt: true,
									updatedAt: true,
									contentType: true,
								},
							},
						},
					},
				},
			},

			password: false, // <-- intentionally omit password
			sessions: true,
		},
	})

	const domain = getDomainUrl(request)

	return json({
		account: {
			...account,
			users: account.users.map(user => ({
				...user,
				image: user.image
					? {
							...user.image,
							url: `${domain}/resources/user-images/${user.image.id}`,
						}
					: null,
				notes: user.notes.map(note => ({
					...note,
					images: note.images.map(image => ({
						...image,
						url: `${domain}/resources/note-images/${image.id}`,
					})),
				})),
			})),
		},
	})
}
