import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  acceptWorkspaceInvitation,
  createHousehold,
  getAccountWorkspaceSnapshot,
  initializeAccountWorkspace,
  inviteWorkspaceMember,
  leaveWorkspace,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  loginAccount,
  logoutAccount,
  refreshAccountSession,
  refreshAccountWorkspace,
  registerAccount,
  removeWorkspaceMember,
  setAccountApiUrl,
  subscribeAccountWorkspace
} from '@/account/accountWorkspace';
import type { AccountWorkspace, WorkspaceInvitation, WorkspaceMember } from '@/account/contracts';

type AuthMode = 'login' | 'register';

export function AccountSharingSection() {
  const account = useSyncExternalStore(
    subscribeAccountWorkspace,
    getAccountWorkspaceSnapshot,
    getAccountWorkspaceSnapshot
  );
  const [apiUrlDraft, setApiUrlDraft] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [householdName, setHouseholdName] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [expandedSpaceId, setExpandedSpaceId] = useState<string | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [oneTimeToken, setOneTimeToken] = useState('');
  const [oneTimeInviteEmail, setOneTimeInviteEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceMember | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<AccountWorkspace | null>(null);
  const [inputError, setInputError] = useState('');

  useEffect(() => {
    void initializeAccountWorkspace();
  }, []);

  useEffect(() => setApiUrlDraft(account.apiUrl), [account.apiUrl]);

  useEffect(() => {
    setOneTimeToken('');
    setOneTimeInviteEmail('');
    setCopied(false);
    setMembers([]);
    setInvitations([]);
    setExpandedSpaceId(null);
    setConfirmRemove(null);
    setConfirmLeave(null);
  }, [account.apiUrl, account.user?.id]);

  useEffect(() => {
    let active = true;
    if (!expandedSpaceId || account.status !== 'signed-in') {
      setMembers([]);
      setInvitations([]);
      return () => { active = false; };
    }

    void (async () => {
      try {
        const nextMembers = await listWorkspaceMembers(expandedSpaceId);
        if (!active) return;
        setMembers(nextMembers);
        const space = account.spaces.find((item) => item.id === expandedSpaceId);
        if (space?.role === 'owner') {
          const nextInvitations = await listWorkspaceInvitations(expandedSpaceId);
          if (active) setInvitations(nextInvitations);
        } else {
          setInvitations([]);
        }
      } catch {
        if (active) {
          setMembers([]);
          setInvitations([]);
        }
      }
    })();

    return () => { active = false; };
  }, [expandedSpaceId, account.status, account.spaces]);

  const busy = account.busyAction !== null;
  const authenticated = account.status === 'signed-in';
  const offline = account.status === 'offline';
  const sessionActive = authenticated || offline || account.status === 'restoring';

  const run = async (action: () => Promise<unknown>) => {
    setInputError('');
    try {
      await action();
    } catch {
      // The account store publishes safe, user-facing errors. Never log request data.
    }
  };

  const saveApiUrl = async () => {
    setInputError('');
    try {
      await setAccountApiUrl(apiUrlDraft);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : 'The API URL could not be saved.');
    }
  };

  const submitAuth = async () => {
    if (!email.trim() || !password) {
      setInputError('Enter both your email address and password.');
      return;
    }
    setInputError('');
    try {
      if (authMode === 'register') await registerAccount(email.trim(), password);
      else await loginAccount(email.trim(), password);
      setPassword('');
    } catch {
      // Error is published by the account store; password remains only in this form.
    }
  };

  const makeHousehold = async () => {
    if (!householdName.trim()) {
      setInputError('Enter a household name.');
      return;
    }
    setInputError('');
    try {
      const created = await createHousehold(householdName.trim());
      setHouseholdName('');
      setExpandedSpaceId(created.id);
    } catch {
      // The store presents the server response or ambiguity warning.
    }
  };

  const sendInvite = async (space: AccountWorkspace) => {
    if (!inviteEmail.trim()) {
      setInputError('Enter the email address that should receive this invitation.');
      return;
    }
    setInputError('');
    try {
      const invitation = await inviteWorkspaceMember(space.id, inviteEmail.trim(), inviteRole);
      setOneTimeToken(invitation.token ?? '');
      setOneTimeInviteEmail(invitation.email);
      setCopied(false);
      setInviteEmail('');
      const refreshed = await listWorkspaceInvitations(space.id);
      setInvitations(refreshed);
    } catch {
      // The token is shown only after a confirmed successful response.
    }
  };

  const copyInviteToken = async () => {
    if (!oneTimeToken) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(oneTimeToken);
      } else {
        await Clipboard.setStringAsync(oneTimeToken);
      }
      setCopied(true);
      setInputError('');
    } catch {
      setCopied(false);
      setInputError('Copy was blocked. Select the token text and copy it manually.');
    }
  };

  const acceptInvite = async () => {
    if (!inviteToken.trim()) {
      setInputError('Paste the invitation token first.');
      return;
    }
    setInputError('');
    try {
      await acceptWorkspaceInvitation(inviteToken.trim());
      setInviteToken('');
    } catch {
      // A replay, expiry, or email mismatch is shown from the API error code.
    }
  };

  const confirmRemoveMember = async (spaceId: string) => {
    if (!confirmRemove) return;
    const target = confirmRemove;
    setConfirmRemove(null);
    await run(async () => {
      await removeWorkspaceMember(spaceId, target.user.id);
      setMembers((current) => current.filter((member) => member.user.id !== target.user.id));
      setInputError('');
    });
  };

  const confirmLeaveHousehold = async () => {
    if (!confirmLeave) return;
    const target = confirmLeave;
    setConfirmLeave(null);
    await run(async () => {
      await leaveWorkspace(target.id);
      if (expandedSpaceId === target.id) setExpandedSpaceId(null);
    });
  };

  const toggleSpace = (spaceId: string) => {
    setInputError('');
    setOneTimeToken('');
    setOneTimeInviteEmail('');
    setCopied(false);
    setMembers([]);
    setInvitations([]);
    setExpandedSpaceId((current) => current === spaceId ? null : spaceId);
  };

  const otherOwnerExists = members.some((member) => member.role === 'owner' && member.user.id !== account.user?.id);

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>Account & sharing</Text>
      <Text style={styles.sectionSubtitle}>
        Use an account for personal workspaces and household membership. Cooking content is still stored on this device and is not shared yet. Provider API keys stay on this device.
      </Text>
      <View style={styles.body}>
        <View style={styles.disclosure}>
          <Text style={styles.disclosureTitle}>What an account stores</Text>
          <Text style={styles.help}>
            The service stores your account, session and household membership details. Cooking data has not been connected to households. When content sharing is added, service operators and authorized household members will be able to read it; it will not be end-to-end encrypted.
          </Text>
        </View>

        <Text style={styles.label}>API base URL</Text>
        <View style={styles.inline}>
          <TextInput
            accessibilityLabel="API base URL"
            value={apiUrlDraft}
            onChangeText={setApiUrlDraft}
            editable={!sessionActive && !busy}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://api.example.com"
            placeholderTextColor="#94a3b8"
            style={[styles.input, (sessionActive || busy) && styles.inputDisabled]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save API URL"
            disabled={sessionActive || busy}
            onPress={() => void saveApiUrl()}
            style={[styles.smallButton, (sessionActive || busy) && styles.disabledButton]}
          >
            <Text style={styles.smallButtonText}>Save</Text>
          </Pressable>
        </View>
        <Text style={styles.help}>
          Leave this blank to use the app locally without an account. Remote services must use HTTPS; HTTP is accepted only for localhost development. Sign out before changing the API address.
        </Text>

        <View accessibilityLiveRegion="polite" style={styles.statusBox}>
          <Text style={styles.statusTitle}>
            {account.status === 'loading' || account.status === 'restoring' ? 'Checking account…' :
              account.status === 'local' ? 'Local on this device' :
                account.status === 'signed-out' ? 'Not signed in' :
                  account.status === 'offline' ? 'Account could not be checked offline' :
                    account.status === 'expired' ? 'Session expired' : `Signed in as ${account.user?.email ?? account.sessionEmail ?? 'account'}`}
          </Text>
          {!!account.notice && <Text style={styles.success}>{account.notice}</Text>}
          {!!account.error && <Text style={styles.error}>{account.error}</Text>}
          {!!inputError && <Text style={styles.error}>{inputError}</Text>}
        </View>

        {offline && (
          <View style={styles.buttonRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="Check account connection" disabled={busy} onPress={() => void run(refreshAccountWorkspace)} style={[styles.primaryButton, busy && styles.disabledButton]}>
              <Text style={styles.primaryButtonText}>{busy ? 'Checking…' : 'Check connection'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Sign out from saved session" disabled={busy} onPress={() => void run(logoutAccount)} style={[styles.smallButton, busy && styles.disabledButton]}>
              <Text style={styles.smallButtonText}>Sign out</Text>
            </Pressable>
          </View>
        )}

        {!sessionActive && account.apiUrl && (
          <>
            <View style={styles.modeRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="Sign in mode" accessibilityState={{ selected: authMode === 'login' }} onPress={() => setAuthMode('login')} style={[styles.modeButton, authMode === 'login' && styles.modeButtonActive]}>
                <Text style={[styles.modeButtonText, authMode === 'login' && styles.modeButtonTextActive]}>Sign in</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Create account mode" accessibilityState={{ selected: authMode === 'register' }} onPress={() => setAuthMode('register')} style={[styles.modeButton, authMode === 'register' && styles.modeButtonActive]}>
                <Text style={[styles.modeButtonText, authMode === 'register' && styles.modeButtonTextActive]}>Create account</Text>
              </Pressable>
            </View>
            <TextInput
              accessibilityLabel="Email address"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder="you@example.com"
              placeholderTextColor="#94a3b8"
              style={styles.input}
              returnKeyType="next"
            />
            <View style={styles.inline}>
              <TextInput
                accessibilityLabel="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType={authMode === 'register' ? 'newPassword' : 'password'}
                placeholder="Password"
                placeholderTextColor="#94a3b8"
                style={styles.input}
                onSubmitEditing={() => void submitAuth()}
                returnKeyType="go"
              />
              <Pressable accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} accessibilityState={{ selected: showPassword }} onPress={() => setShowPassword((value) => !value)} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>{showPassword ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={authMode === 'register' ? 'Create account' : 'Sign in'} disabled={busy || !email.trim() || !password} onPress={() => void submitAuth()} style={[styles.primaryButton, (busy || !email.trim() || !password) && styles.disabledButton]}>
              <Text style={styles.primaryButtonText}>{busy ? 'Connecting…' : authMode === 'register' ? 'Create account' : 'Sign in'}</Text>
            </Pressable>
            <Text style={styles.help}>Passwords are used only for this request and are never saved by the app.</Text>
          </>
        )}

        {authenticated && (
          <>
            <View style={styles.buttonRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="Refresh account session" disabled={busy} onPress={() => void run(refreshAccountSession)} style={[styles.smallButton, busy && styles.disabledButton]}>
                <Text style={styles.smallButtonText}>{busy ? 'Working…' : 'Refresh session'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Check account and household access" disabled={busy} onPress={() => void run(refreshAccountWorkspace)} style={[styles.smallButton, busy && styles.disabledButton]}>
                <Text style={styles.smallButtonText}>Check access</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Sign out" disabled={busy} onPress={() => void run(logoutAccount)} style={[styles.smallButton, busy && styles.disabledButton]}>
                <Text style={styles.smallButtonText}>Sign out</Text>
              </Pressable>
            </View>

            <View style={styles.subsection}>
              <Text accessibilityRole="header" style={styles.subsectionTitle}>Workspaces</Text>
              {account.spaces.map((space) => (
                <View key={space.id} style={styles.spaceRow}>
                  <View style={styles.spaceSummary}>
                    <Text style={styles.spaceName}>{space.name}</Text>
                    <Text style={styles.help}>{space.kind === 'personal' ? 'Personal workspace' : 'Household'} · {space.role}</Text>
                  </View>
                  {space.kind === 'household' && (
                    <Pressable accessibilityRole="button" accessibilityLabel={`${expandedSpaceId === space.id ? 'Hide' : 'View'} members of ${space.name}`} accessibilityState={{ expanded: expandedSpaceId === space.id }} onPress={() => toggleSpace(space.id)} style={styles.smallButton}>
                      <Text style={styles.smallButtonText}>{expandedSpaceId === space.id ? 'Hide' : 'Members'}</Text>
                    </Pressable>
                  )}
                </View>
              ))}
              <Text style={styles.help}>These workspaces currently manage account membership only. Your pantry, recipes, chats, preferences and provider keys remain on this device.</Text>
            </View>

            <View style={styles.subsection}>
              <Text accessibilityRole="header" style={styles.subsectionTitle}>Create household</Text>
              <View style={styles.inline}>
                <TextInput accessibilityLabel="Household name" value={householdName} onChangeText={setHouseholdName} placeholder="e.g. Home" placeholderTextColor="#94a3b8" style={styles.input} maxLength={80} />
                <Pressable accessibilityRole="button" accessibilityLabel="Create household" disabled={busy || !householdName.trim()} onPress={() => void makeHousehold()} style={[styles.smallButton, (busy || !householdName.trim()) && styles.disabledButton]}>
                  <Text style={styles.smallButtonText}>Create</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.subsection}>
              <Text accessibilityRole="header" style={styles.subsectionTitle}>Accept invitation</Text>
              <TextInput accessibilityLabel="Invitation token" value={inviteToken} onChangeText={setInviteToken} autoCapitalize="none" autoCorrect={false} placeholder="Paste one-use invitation token" placeholderTextColor="#94a3b8" style={styles.input} />
              <Text style={styles.help}>Sign in with the invited email address first. Tokens expire after seven days and can be accepted once.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Accept invitation" disabled={busy || !inviteToken.trim()} onPress={() => void acceptInvite()} style={[styles.primaryButton, (busy || !inviteToken.trim()) && styles.disabledButton]}>
                <Text style={styles.primaryButtonText}>{busy ? 'Working…' : 'Accept invitation'}</Text>
              </Pressable>
            </View>

            {expandedSpaceId && (() => {
              const space = account.spaces.find((item) => item.id === expandedSpaceId);
              if (!space) return null;
              return (
                <View style={styles.detailSection}>
                  <Text accessibilityRole="header" style={styles.subsectionTitle}>{space.name} members</Text>
                  {members.length === 0 ? <Text style={styles.help}>Loading members or no members are available.</Text> : members.map((member) => (
                    <View key={member.user.id} style={styles.memberRow}>
                      <View style={styles.memberSummary}>
                        <Text style={styles.memberEmail}>{member.user.email}{member.user.id === account.user?.id ? ' · you' : ''}</Text>
                        <Text style={styles.help}>{member.role}</Text>
                      </View>
                      {space.role === 'owner' && member.user.id !== account.user?.id && (
                        confirmRemove?.user.id === member.user.id ? (
                          <View style={styles.confirmGroup}>
                            <Text style={styles.warning}>Remove {member.user.email}?</Text>
                            <Pressable accessibilityRole="button" accessibilityLabel={`Confirm remove ${member.user.email}`} disabled={busy} onPress={() => void confirmRemoveMember(space.id)} style={[styles.dangerButton, busy && styles.disabledButton]}><Text style={styles.dangerButtonText}>Remove</Text></Pressable>
                            <Pressable accessibilityRole="button" accessibilityLabel="Cancel member removal" onPress={() => setConfirmRemove(null)} style={styles.textButton}><Text style={styles.linkText}>Cancel</Text></Pressable>
                          </View>
                        ) : (
                          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${member.user.email} from ${space.name}`} disabled={busy} onPress={() => setConfirmRemove(member)} style={[styles.textButton, busy && styles.disabledButton]}>
                            <Text style={styles.dangerLink}>Remove</Text>
                          </Pressable>
                        )
                      )}
                    </View>
                  ))}

                  {space.role === 'owner' && (
                    <>
                      <Text accessibilityRole="header" style={styles.subsectionTitle}>Invite a member</Text>
                      <TextInput accessibilityLabel={`Invitation email for ${space.name}`} value={inviteEmail} onChangeText={setInviteEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} placeholder="Email address" placeholderTextColor="#94a3b8" style={styles.input} />
                      <Text style={styles.label}>Role</Text>
                      <View style={styles.modeRow}>
                        {(['editor', 'viewer'] as const).map((role) => (
                          <Pressable key={role} accessibilityRole="button" accessibilityLabel={`Invite as ${role}`} accessibilityState={{ selected: inviteRole === role }} onPress={() => setInviteRole(role)} style={[styles.modeButton, inviteRole === role && styles.modeButtonActive]}>
                            <Text style={[styles.modeButtonText, inviteRole === role && styles.modeButtonTextActive]}>{role}</Text>
                          </Pressable>
                        ))}
                      </View>
                      <Text style={styles.help}>Editors and viewers currently receive membership access only. Cooking content is not shared by these roles yet.</Text>
                      <Pressable accessibilityRole="button" accessibilityLabel={`Invite member to ${space.name}`} disabled={busy || !inviteEmail.trim()} onPress={() => void sendInvite(space)} style={[styles.primaryButton, (busy || !inviteEmail.trim()) && styles.disabledButton]}>
                        <Text style={styles.primaryButtonText}>{busy ? 'Working…' : 'Create invitation'}</Text>
                      </Pressable>
                      {oneTimeToken ? (
                        <View style={styles.tokenBox}>
                          <Text style={styles.label}>One-time invitation token</Text>
                          <TextInput accessibilityLabel="One-time invitation token" value={oneTimeToken} editable={false} selectTextOnFocus multiline style={[styles.input, styles.tokenInput]} />
                          <Pressable accessibilityRole="button" accessibilityLabel="Copy invitation token" onPress={() => void copyInviteToken()} style={styles.smallButton}>
                            <Text style={styles.smallButtonText}>{copied ? 'Copied' : 'Copy token'}</Text>
                          </Pressable>
                          <Text style={styles.warning}>Send this token only to {oneTimeInviteEmail || 'the invited email address'}. It is shown once here, expires in seven days and is not saved by the app.</Text>
                        </View>
                      ) : null}
                      {invitations.length > 0 && (
                        <View style={styles.invitationList}>
                          <Text style={styles.label}>Pending invitations</Text>
                          {invitations.map((invitation) => (
                            <Text key={invitation.id} style={styles.help}>{invitation.email} · {invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</Text>
                          ))}
                        </View>
                      )}
                    </>
                  )}

                  {confirmLeave?.id === space.id ? (
                    <View style={styles.confirmBox}>
                      <Text style={styles.warning}>Leave {space.name}? Your local cooking data will remain on this device.</Text>
                      <View style={styles.buttonRow}>
                        <Pressable accessibilityRole="button" accessibilityLabel={`Confirm leave ${space.name}`} disabled={busy} onPress={() => void confirmLeaveHousehold()} style={[styles.dangerButton, busy && styles.disabledButton]}><Text style={styles.dangerButtonText}>Leave household</Text></Pressable>
                        <Pressable accessibilityRole="button" accessibilityLabel="Cancel leave household" onPress={() => setConfirmLeave(null)} style={styles.smallButton}><Text style={styles.smallButtonText}>Cancel</Text></Pressable>
                      </View>
                    </View>
                  ) : space.role !== 'owner' || otherOwnerExists ? (
                    <Pressable accessibilityRole="button" accessibilityLabel={`Leave ${space.name}`} disabled={busy} onPress={() => setConfirmLeave(space)} style={[styles.textButton, busy && styles.disabledButton]}>
                      <Text style={styles.dangerLink}>Leave household</Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.help}>You are the only owner. The service will not allow the last owner to leave or be removed.</Text>
                  )}
                </View>
              );
            })()}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { backgroundColor: 'white', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 20, padding: 18 },
  sectionTitle: { color: '#172033', fontSize: 19, fontWeight: '800' },
  sectionSubtitle: { color: '#64748b', lineHeight: 19, marginTop: 4 },
  body: { gap: 12, marginTop: 16 },
  disclosure: { backgroundColor: '#f8fafc', borderRadius: 12, padding: 12, gap: 6, borderWidth: 1, borderColor: '#e2e8f0' },
  disclosureTitle: { color: '#334155', fontWeight: '800' },
  label: { color: '#334155', fontWeight: '700' },
  help: { color: '#64748b', fontSize: 12.5, lineHeight: 18 },
  warning: { color: '#92400e', fontSize: 12.5, lineHeight: 18 },
  error: { color: '#b91c1c', fontSize: 13, lineHeight: 19 },
  success: { color: '#166534', fontSize: 13, lineHeight: 19 },
  inline: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 200, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#cbd5e1', paddingHorizontal: 12, paddingVertical: 9, color: '#172033', backgroundColor: '#fff' },
  inputDisabled: { backgroundColor: '#f1f5f9', color: '#64748b' },
  statusBox: { backgroundColor: '#f8fafc', borderRadius: 12, padding: 12, gap: 6, borderWidth: 1, borderColor: '#e2e8f0' },
  statusTitle: { color: '#172033', fontWeight: '800' },
  primaryButton: { minHeight: 44, backgroundColor: '#172033', borderRadius: 13, paddingHorizontal: 15, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: 'white', fontWeight: '700', textAlign: 'center' },
  smallButton: { minHeight: 44, backgroundColor: '#e2e8f0', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  smallButtonText: { color: '#334155', fontWeight: '700', textAlign: 'center' },
  disabledButton: { opacity: 0.45 },
  buttonRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  modeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  modeButton: { minHeight: 42, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 9, backgroundColor: '#e2e8f0', justifyContent: 'center' },
  modeButtonActive: { backgroundColor: '#172033' },
  modeButtonText: { color: '#475569', fontWeight: '700' },
  modeButtonTextActive: { color: 'white' },
  subsection: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e2e8f0' },
  subsectionTitle: { color: '#172033', fontSize: 15, fontWeight: '800' },
  spaceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  spaceSummary: { flex: 1, gap: 3 },
  spaceName: { color: '#172033', fontWeight: '700' },
  detailSection: { gap: 11, backgroundColor: '#f8fafc', borderRadius: 12, padding: 12 },
  memberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  memberSummary: { flex: 1, gap: 3 },
  memberEmail: { color: '#172033', fontWeight: '600' },
  textButton: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 8 },
  dangerLink: { color: '#b91c1c', fontWeight: '600' },
  linkText: { color: '#334155', fontWeight: '600' },
  dangerButton: { minHeight: 44, borderRadius: 12, backgroundColor: '#fee2e2', paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  dangerButtonText: { color: '#991b1b', fontWeight: '700' },
  confirmGroup: { alignItems: 'flex-end', gap: 4 },
  confirmBox: { gap: 8, padding: 10, backgroundColor: '#fffbeb', borderRadius: 10 },
  tokenBox: { gap: 8, padding: 11, backgroundColor: '#fffbeb', borderRadius: 11, borderWidth: 1, borderColor: '#fde68a' },
  tokenInput: { maxHeight: 96, fontSize: 12 },
  invitationList: { gap: 5, paddingTop: 5 }
});
