# Preserved v1 sources

These files are retained for review during the ViewCode v2 port. They are outside the server TypeScript and test roots and are not shipped or loaded. Active replacements use upstream orchestration-v2, the native GitHub API packages, and AgentMessagingV2. The `.disabled` suffix prevents accidental compilation or test discovery. Their old imports are intentionally unchanged so the original implementation remains available.
