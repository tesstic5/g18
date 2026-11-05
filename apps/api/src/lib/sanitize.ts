import sanitizeHtml from 'sanitize-html';

/**
 * Allow-list sanitizer for admin-authored legal content.
 *
 * This deliberately uses an HTML parser rather than regular expressions. Regex
 * handling can be bypassed with malformed tags, entities, whitespace/control
 * characters in URL schemes, or unclosed elements.
 */
export function sanitizeRichText(html: string): string {
  if (!html) return '';
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'hr',
      'blockquote',
      'pre',
      'code',
      'h1',
      'h2',
      'h3',
      'h4',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          rel: 'noopener noreferrer',
          ...(attribs.target === '_blank' ? { target: '_blank' } : {}),
        },
      }),
    },
  });
}
