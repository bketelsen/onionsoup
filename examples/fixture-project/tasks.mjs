// Dependency-free, operator-owned fixture. Inputs are arrays of task objects.
export function completedCount(tasks) {
  return tasks.filter(task => task.done).length;
}

export function listTasks(tasks) {
  return tasks.map(task => task.name).join('\n');
}
