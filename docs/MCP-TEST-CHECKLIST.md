# MCP Test Checklist

Use this checklist with an MCP client (Claude Code, Claude Desktop) to manually
verify the tools work end to end against a real Vikunja server. Point the client
at a disposable local stack first — see [docs/LOCAL-TESTING.md](LOCAL-TESTING.md)
— and create a project named `MCP-Test` to hold the throwaway data; the steps
below assume it exists. The automated equivalents of this walkthrough are
`npm run test:mcp` (direct REST) and `npm run test:e2e:mcp` (the MCP tool layer).

## Setup

Before starting, verify the MCP connection:

```text
Use vikunja_auth status to check connection
```

Expected: shows authenticated with API URL.

## Tier 1: core operations

### Task CRUD

- [ ] **Create task**
  ```text
  Use vikunja_tasks create to create a task with title "Test Task 1", description "Testing", priority high in the MCP-Test project
  ```
  Verify: Response shows task created with correct fields

- [ ] **Read task**
  ```text
  Use vikunja_tasks get to get the task you just created by ID
  ```
  Verify: Returns same title, description, priority

- [ ] **Update task**
  ```text
  Use vikunja_tasks update to update that task's title to "Test Task Updated" and priority to urgent
  ```
  Verify: Read it back, changes persisted

- [ ] **Delete task**
  ```text
  Use vikunja_tasks delete to delete that task
  ```
  Verify: Getting the task by ID returns error

- [ ] **List tasks**
  ```text
  Create 3 tasks, then use vikunja_tasks list to list tasks in the project
  ```
  Verify: All 3 appear in list

### Task labels

- [ ] **Apply label**
  ```text
  Create a task and a label, then use vikunja_task_labels to apply the label to the task
  ```
  Verify: Get task, label appears in labels array

- [ ] **Apply multiple labels**
  ```text
  Apply a second label to the same task
  ```
  Verify: Task now has both labels

- [ ] **Remove label**
  ```text
  Use vikunja_task_labels to remove one label
  ```
  Verify: Only one label remains

- [ ] **List task labels**
  ```text
  Use vikunja_task_labels list-labels on the task
  ```
  Verify: Shows remaining label

### Labels CRUD

- [ ] **Create label**
  ```text
  Use vikunja_labels create with title "test-label", color #22c55e
  ```
  Verify: Label created with correct fields

- [ ] **List labels**
  ```text
  Use vikunja_labels list
  ```
  Verify: Returns array (not null), includes created label

- [ ] **Update label**
  ```text
  Use vikunja_labels update to change title and color
  ```
  Verify: Changes persisted on read-back

- [ ] **Delete label**
  ```text
  Use vikunja_labels delete
  ```
  Verify: Label no longer in list

### Projects

- [ ] **Create project**
  ```text
  Use vikunja_projects create with title "Test Project"
  ```
  Verify: Project appears in list

- [ ] **Create child project**
  ```text
  Use vikunja_projects create with parentProjectId set to the project above
  ```
  Verify: Child project has correct parent

- [ ] **Update project**
  ```text
  Use vikunja_projects update to change title
  ```
  Verify: Title changed on read-back

- [ ] **Archive project**
  ```text
  Use vikunja_projects archive
  ```
  Verify: Project shows as archived

- [ ] **Delete project**
  ```text
  Use vikunja_projects delete (delete child first)
  ```
  Verify: Project no longer exists

## Tier 2: smoke tests

### Filters

- [ ] **Build filter**
  ```text
  Use vikunja_filters build for priority = high
  ```
  Verify: Returns valid filter string

- [ ] **List with filter**
  ```text
  Create tasks with different priorities, list with filter
  ```
  Verify: Only matching tasks returned

### Bulk operations

- [ ] **Bulk create**
  ```text
  Use vikunja_task_bulk bulk-create to create 3 tasks
  ```
  Verify: All 3 created

### Task extras

- [ ] **Add comment**
  ```text
  Use vikunja_task_comments to add a comment
  ```
  Verify: Comment appears on task

- [ ] **Add relation**
  ```text
  Use vikunja_task_relations to relate two tasks
  ```
  Verify: Relation exists

## Cleanup

After testing:

```text
Delete all test projects, labels, and tasks created during testing
```
