const inheritedSessionKey = /^(HCOM_|ANTIGRAVITY_|GEMINI_|CODEX_THREAD_ID$|CODEX_SESSION_ID$|CODEX_TOOL_CALL_ID$|CLAUDECODE$|CLAUDE_CODE|CLAUDE_SESSION_ID$|CLAUDE_ENV_FILE$)/i;

export function sessionEnvironment(source: NodeJS.ProcessEnv, hcomDir?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !inheritedSessionKey.test(key)));
  if (hcomDir !== undefined) env.HCOM_DIR = hcomDir;
  return env;
}
