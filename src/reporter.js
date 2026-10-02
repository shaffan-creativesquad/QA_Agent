'use strict';

const TYPE_LABELS = {
  placeholder:   'Placeholder Content',
  broken_image:  'Broken Images',
  image:         'Images',
  button:        'Buttons',
  dead_link:     'Dead Links',
  seo_heading:   'SEO Headings (H1/H2)',
  form:          'Forms',
  html:          'HTML Structure',
  visual:        'Visual (AI)',
  broken_link:   'Broken External Links',
  missing_resource: 'Missing Resources',
  js_error:      'JS Errors',
  http_error:    'HTTP Errors',
  load_failure:  'Load Failures',
  performance:   'Performance',
  security:      'Security',
  wp_security:   'WordPress Security',
  proofreading:  'Proofreading',
  ai_content:    'AI-Generated Content',
};

function buildReport(pages) {
  const allIssues = pages.flatMap(p => p.issues || []);

  const byType = {};
  for (const issue of allIssues) {
    const label = TYPE_LABELS[issue.type] || issue.type;
    byType[label] = (byType[label] || 0) + 1;
  }

  const pagesWithIssues = pages.filter(p => (p.issues || []).length > 0).length;

  return {
    totalPages: pages.length,
    totalIssues: allIssues.length,
    pagesWithIssues,
    byType,
    issues: allIssues,
  };
}

module.exports = { buildReport };
