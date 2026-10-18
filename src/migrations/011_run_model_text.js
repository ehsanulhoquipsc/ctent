'use strict';
// Kept as a no-op: the AI label is shortened to fit agent_runs.model in code (lib/agent.js), and runs that
// failed on that save are restored by agent.rescueSaved(). Altering the column here could wait on locks
// held by the running instance during a deploy.
exports.up = async function up() {};
exports.down = async function down() {};
