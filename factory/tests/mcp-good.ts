const rows = { rows: 'tasks', id: 'id', title: 'title', state: 'state' }
export const step = (name: string, extra: Record<string, unknown> = {}) => ({ tool: 'set_step', args: { task_id: '{id}', step: name }, ...extra })

export const GOOD: Record<string, any> = {
  kind: 'mcp',
  mark: 'factory',
  server: 'tasks',
  url: 'https://tracker.example.com/tasks/{id}',
  list: { tool: 'find_tasks', args: { label: '{mark}', states: ['open'] }, ...rows },
  claimed: { tool: 'find_tasks', args: { label: '{mark}', states: ['doing'] }, ...rows },
  read: {
    tool: 'get_task',
    args: { task_id: '{id}' },
    title: 'title',
    text: 'description',
    author: 'made_by',
    state: 'state',
    labels: 'labels',
    comments: 'comments',
    commentAuthor: 'by',
    commentText: 'text',
  },
  comment: { tool: 'add_comment', args: { task_id: '{id}', text: '{text}' } },
  states: {
    'in-progress': [step('doing')],
    'needs-human': [step('review', { optional: true })],
    done: [step('done')],
    rejected: [{ tool: 'cancel_task', args: { task_id: '{id}' } }],
  },
  linkPr: { tool: 'link_code', args: { task_id: '{id}', ref: '{url}' } },
  me: { tool: 'who_am_i', args: {}, name: 'name' },
}

