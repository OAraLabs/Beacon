// What a script outside the app needs of a project's instructions and files: the class that asks, and the REST client it asks through. Built
// as its own file (out/main/chat-projects-content-entry.js) so `npm run probe:chat-projects-content` can drive the REAL transport and the
// REAL class against a REAL daemon.
export { ChatProjectContent } from './chat-projects-content'
export { RestClient } from './connection/rest'
