# Production Exercise Harness

The HTTP runner schedules a bounded open-loop request rate and writes one
versioned JSON evidence file. It never writes authorization values or request
bodies to evidence. Output creation is exclusive so reruns cannot overwrite a
prior result.

Required environment:

- `PERTEXO_EXERCISE_BASE_URL`: target origin.
- `PERTEXO_EXERCISE_PATH`: concrete API path for the selected workspace and
  resource. Evidence stores only its SHA-256 digest.
- `PERTEXO_EXERCISE_BODY_FILE`: local JSON request body. The file is not copied
  into evidence.
- `PERTEXO_EXERCISE_AUTHORIZATION`: deployment-issued authorization header. It
  is held only in process memory.

Run a profile with:

```sh
pnpm exercise:http infrastructure/exercises/profiles/api-steady.json evidence/api-steady.json
```

The 20 requests/second profile is a one-minute local confidence run. The 50
requests/second profile is the required five-minute burst. A passing local file
does not prove ECS, RDS, regional recovery, pager routing, or production SLO
attainment. Preserve production evidence in the approved operations evidence
system, not in Git.
