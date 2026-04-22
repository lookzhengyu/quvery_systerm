import { handleRequest } from '../server/mock-queue-server.mjs';

export default async function vercelHandler(request, response) {
  await handleRequest(request, response);
}
