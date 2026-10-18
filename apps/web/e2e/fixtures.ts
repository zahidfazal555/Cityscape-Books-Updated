export const PASSWORD = 'E2E-only-pass-phrase-2026';
export const USERS = [
  { role: 'owner', name: 'Saravanan S', email: 'owner@e2e.test' },
  { role: 'admin', name: 'Accounts Admin', email: 'admin@e2e.test' },
  { role: 'manager', name: 'Shiva', email: 'pm@e2e.test' },
  { role: 'site', name: 'Site Engineer', email: 'site@e2e.test' },
] as const;
export const email = (role: (typeof USERS)[number]['role']) =>
  USERS.find((u) => u.role === role)!.email;

/** A real 8×8 JPEG with an EXIF segment carrying a GPS string. */
export const JPEG = Buffer.from(
  '/9j/4QAMRXhpZgAAR1BTIf/gABBKRklGAAEBAAABAAEAAP/bAIQABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFB' +
    'gYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKAEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgo' +
    'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8AAEQgACAAIAwERAAIRAQMRAf/EAaIAAAEFAQEBAQEBAA' +
    'AAAAAAAAABAgMEBQYHCAkKCxAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk' +
    'M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJ' +
    'WWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6AQADAQEB' +
    'AQEBAQEBAAAAAAAAAQIDBAUGBwgJCgsRAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQ' +
    'kjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWG' +
    'h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v' +
    '/aAAwDAQACEQMRAD8A9FoA/wD/2Q==',
  'base64',
);
