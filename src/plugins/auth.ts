import { FastifyRequest, FastifyReply } from 'fastify';

/** Token desde cookie o desde header Authorization: Bearer (cross-origin no envía cookie). */
function getToken(request: FastifyRequest): string | undefined {
    const fromCookie = request.cookies?.token;
    if (fromCookie) return fromCookie;
    const auth = request.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return undefined;
}

/**
 * Acepta JWT en cookie (token) o en header Authorization: Bearer <token>.
 * Si es válido asigna request.user; si no, 401.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const token = getToken(request);
    if (!token) {
        return reply.status(401).send({
            statusCode: 401,
            code: 'FST_JWT_NO_AUTHORIZATION',
            error: 'Unauthorized',
            message: 'No token in cookie or Authorization header',
        });
    }
    try {
        const decoded = await request.server.jwt.verify(token);
        (request as any).user = decoded;
    } catch (err) {
        throw err;
    }
}
