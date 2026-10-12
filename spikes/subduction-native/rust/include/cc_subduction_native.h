#pragma once
#ifdef __cplusplus
extern "C" {
#endif
/* Returns heap-owned UTF-8 JSON. Caller MUST call cc_subduction_free exactly once. */
char *cc_subduction_run(const char *request_utf8);
void cc_subduction_free(char *result);
#ifdef __cplusplus
}
#endif
