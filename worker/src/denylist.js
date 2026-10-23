// Takedown denylist: songs the Worker refuses to serve (HTTP 451, "unavailable for legal
// reasons"). When a rights holder or a site asks for a song to be removed from the app, add
// it here and redeploy; no other change is needed.
//
// An entry is either
//   - a full URL prefix:  "https://www.beakauffmann.com/midi/Some%20Artist/"
//   - a path prefix, which applies to every allowed host:  "/midi/Some%20Artist/"
// Case and percent-encoding are ignored, so "João" and "Jo%C3%A3o" are the same entry.
export const DENYLIST = [];
