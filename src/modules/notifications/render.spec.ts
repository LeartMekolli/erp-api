import { renderTemplate, TEMPLATE_LIMITS, validateTemplate } from './render';

const noUrls: ReadonlySet<string> = new Set();

describe('renderTemplate', () => {
  it('substitutes variables, tolerating spaces inside braces', () => {
    const rendered = renderTemplate(
      { subject: 'Hi {{user_name}}', body: 'Roles: {{ roles }}.' },
      { user_name: 'Ada', roles: 'owner, member' },
      noUrls,
    );

    expect(rendered.subject).toBe('Hi Ada');
    expect(rendered.text).toBe('Roles: owner, member.');
    expect(rendered.html).toContain('Roles: owner, member.');
  });

  it('escapes HTML in values and in the template text', () => {
    const rendered = renderTemplate(
      { subject: 'Hello', body: '<b>Welcome</b> {{ user_name }}' },
      { user_name: '<img src=x onerror=alert(1)>' },
      noUrls,
    );

    expect(rendered.html).toContain('&lt;b&gt;Welcome&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).not.toContain('<b>');
    expect(rendered.text).toBe('<b>Welcome</b> <img src=x onerror=alert(1)>');
  });

  it('collapses whitespace and newlines in the subject', () => {
    const rendered = renderTemplate(
      { subject: 'Hello  {{ user_name }}', body: 'x' },
      { user_name: 'A\r\nBcc: x@y' },
      noUrls,
    );

    expect(rendered.subject).toBe('Hello A Bcc: x@y');
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  it('paragraphs and line breaks become <p> and <br>', () => {
    const rendered = renderTemplate({ subject: 's', body: 'One\nTwo\n\nThree' }, {}, noUrls);

    expect(rendered.html).toContain('<p>One<br>Two</p><p>Three</p>');
    expect(rendered.text).toBe('One\nTwo\n\nThree');
  });

  it('url variables become links in html only, and only for http(s)', () => {
    const urls: ReadonlySet<string> = new Set(['link']);
    const safe = renderTemplate(
      { subject: 's', body: 'Open {{ link }}' },
      { link: 'https://acme.example/accept?a=1&b=2' },
      urls,
    );

    expect(safe.html).toContain(
      '<a href="https://acme.example/accept?a=1&amp;b=2">https://acme.example/accept?a=1&amp;b=2</a>',
    );
    expect(safe.text).toBe('Open https://acme.example/accept?a=1&b=2');

    const unsafe = renderTemplate({ subject: 's', body: 'Open {{ link }}' }, { link: 'javascript:alert(1)' }, urls);
    expect(unsafe.html).toContain('Open javascript:alert(1)');
    expect(unsafe.html).not.toContain('<a ');
  });

  it('wraps the html body in the layout', () => {
    const rendered = renderTemplate({ subject: 'Subject line', body: 'Body' }, {}, noUrls);

    expect(rendered.html).toMatch(/^<!doctype html>/i);
    expect(rendered.html).toContain('<p>Body</p>');
  });
});

describe('validateTemplate', () => {
  const valid = { subject: 'Join {{ tenant_name }}', body: 'Accept here: {{ link }}' };

  it('accepts a template using only its event variables', () => {
    expect(validateTemplate('user.invited', valid)).toEqual([]);
  });

  it('reports an unknown variable', () => {
    expect(validateTemplate('user.invited', { ...valid, body: '{{ link }} {{ nope }}' })).toEqual([
      { path: 'body', message: expect.stringContaining('nope') },
    ]);
  });

  it('reports an unclosed placeholder', () => {
    expect(validateTemplate('user.invited', { ...valid, subject: 'Join {{ tenant_name' })).toEqual([
      { path: 'subject', message: expect.stringContaining('{{') },
    ]);
  });

  it('reports a missing required variable', () => {
    expect(validateTemplate('user.invited', { ...valid, body: 'No link at all' })).toEqual([
      { path: 'body', message: expect.stringContaining('link') },
    ]);
  });

  it('reports oversize subject and body', () => {
    const issues = validateTemplate('user.invited', {
      subject: 'x'.repeat(TEMPLATE_LIMITS.subject + 1),
      body: `{{ link }}${'x'.repeat(TEMPLATE_LIMITS.body)}`,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'subject', message: expect.any(String) },
        { path: 'body', message: expect.any(String) },
      ]),
    );
    expect(TEMPLATE_LIMITS).toEqual({ subject: 200, body: 10_000 });
  });
});
