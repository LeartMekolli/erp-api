import { EventKey, variablesOf } from './catalogue';
import { emailLayout } from './layout';

/** Size caps for a template (D69). */
export const TEMPLATE_LIMITS = { subject: 200, body: 10_000 } as const;

export interface Template {
  subject: string;
  body: string;
}

export interface TemplateIssue {
  path: 'subject' | 'body';
  message: string;
}

/** `{{ name }}`, spaces allowed inside the braces. Sticky: matched at one index. */
const PLACEHOLDER_AT = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/y;

type Segment = { literal: string } | { variable: string };

/**
 * Splits template text into literals and placeholders. Returns `null` at the
 * first `{{` that does not open a well-formed placeholder.
 */
function parse(text: string): Segment[] | null {
  const segments: Segment[] = [];
  let position = 0;

  while (position < text.length) {
    const open = text.indexOf('{{', position);
    if (open === -1) {
      segments.push({ literal: text.slice(position) });
      break;
    }
    if (open > position) {
      segments.push({ literal: text.slice(position, open) });
    }
    PLACEHOLDER_AT.lastIndex = open;
    const match = PLACEHOLDER_AT.exec(text);
    if (!match) {
      return null;
    }
    segments.push({ variable: match[1] });
    position = PLACEHOLDER_AT.lastIndex;
  }

  return segments;
}

/**
 * What is wrong with a template for an event, field by field: too long, a
 * malformed or unclosed `{{`, a variable the event does not declare, a
 * required variable (an invitation's link) left out of the body, or a secret
 * variable in the subject, where it would show in inbox lists and mail logs.
 */
export function validateTemplate(event: EventKey, template: Template): TemplateIssue[] {
  const declared = variablesOf(event);
  const issues: TemplateIssue[] = [];
  const usedInBody = new Set<string>();

  for (const path of ['subject', 'body'] as const) {
    const text = template[path];
    if (text.length > TEMPLATE_LIMITS[path]) {
      issues.push({ path, message: `Must be at most ${TEMPLATE_LIMITS[path]} characters` });
    }

    const segments = parse(text);
    if (!segments) {
      issues.push({ path, message: 'Contains an unclosed or malformed {{ placeholder }}' });
      continue;
    }

    const unknown = new Set<string>();
    for (const segment of segments) {
      if ('variable' in segment) {
        if (path === 'body') {
          usedInBody.add(segment.variable);
        }
        if (!(segment.variable in declared)) {
          unknown.add(segment.variable);
        } else if (path === 'subject' && declared[segment.variable]?.secret) {
          issues.push({ path, message: `The {{ ${segment.variable} }} variable cannot be used in the subject` });
        }
      }
    }
    for (const name of unknown) {
      issues.push({ path, message: `Unknown variable "${name}"` });
    }
  }

  for (const [name, spec] of Object.entries(declared)) {
    if (spec.required && !usedInBody.has(name)) {
      issues.push({ path: 'body', message: `The body must use the {{ ${name} }} variable` });
    }
  }

  return issues;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function substitute(text: string, variables: Record<string, string>): string {
  return (parse(text) ?? [{ literal: text }])
    .map((segment) => ('literal' in segment ? segment.literal : (variables[segment.variable] ?? '')))
    .join('');
}

/**
 * Renders a validated template. The subject is one line of plain text, so a
 * value cannot add a mail header. The text body is substituted as is. The
 * HTML body escapes everything — template text and values alike — so neither
 * staff nor users can inject markup; only http(s) URL variables become links.
 */
export function renderTemplate(
  template: Template,
  variables: Record<string, string>,
  urlVariables: ReadonlySet<string>,
): { subject: string; text: string; html: string } {
  const subject = substitute(template.subject, variables).replace(/\s+/g, ' ').trim();
  const text = substitute(template.body, variables);

  const escaped = (parse(template.body) ?? [{ literal: template.body }])
    .map((segment) => {
      if ('literal' in segment) {
        return escapeHtml(segment.literal);
      }
      const value = variables[segment.variable] ?? '';
      if (urlVariables.has(segment.variable) && /^https?:\/\//i.test(value)) {
        return `<a href="${escapeHtml(value)}">${escapeHtml(value)}</a>`;
      }
      return escapeHtml(value);
    })
    .join('');

  const bodyHtml = escaped
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${paragraph.replace(/\r?\n/g, '<br>')}</p>`)
    .join('');

  return { subject, text, html: emailLayout(escapeHtml(subject), bodyHtml) };
}
