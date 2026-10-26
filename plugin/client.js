window.__ModuleLoader__.load({
  id: '@local/dsh-remote',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-remote';

    const zh = {
      tabLabel: '远程配对',
      title: 'DSH Remote',
      subtitle: '将本机 Harness 连接到 HRP v1 Relay，让已配对的手机访问本地会话。',
      sectionConnection: 'Relay 连接',
      sectionPairing: '手机配对',
      sectionMembers: '已配对设备',
      labelRelay: '远程地址',
      labelName: '显示名称',
      labelToken: '注册令牌',
      tokenPlaceholderNew: '首次连接时填写 Relay 的注册令牌',
      tokenPlaceholderSaved: '已保存，留空表示不修改',
      save: '保存并连接',
      disconnect: '断开',
      connect: '连接',
      clearToken: '清除令牌',
      tokenSaved: '注册令牌已保存',
      createPairing: '生成配对码',
      copy: '复制',
      copied: '已复制',
      pairHint: '在手机端输入此配对码。配对码 5 分钟内有效，仅可使用一次。',
      pairExpires: '剩余有效期',
      pairExpired: '配对码已过期，请重新生成。',
      pairBusy: 'Relay 上已有未使用的配对码，请等待其过期后再生成。',
      ownerExists: '已有 owner 设备。给新手机配对请在该手机的「设备与分享」里生成绑定码；要重新生成 owner 码，请先移除旧 owner。',
      remove: '移除',
      confirmRemove: '确认移除',
      cancel: '取消',
      removeWarning: '移除后该设备将立即失去访问权限，需要重新配对才能恢复。',
      removeOwnerWarning: '这是 owner 设备。移除后该设备立即失去权限；如果它是最后一台 owner，之后可以重新生成 owner 配对码。',
      memberRemoved: '设备已移除',
      stateOnline: '已连接',
      stateConnecting: '连接中',
      stateHandshaking: '握手中',
      stateDisconnected: '未连接',
      stateError: '连接异常',
      harnessId: 'Harness ID',
      aclVersion: 'ACL 版本',
      noMembers: '还没有已配对设备。生成配对码后，在手机端完成配对。',
      roleOwner: '所有者',
      roleMember: '成员',
      userId: '用户',
      deviceId: '设备',
      error: '操作失败',
      saved: '配置已保存',
      emptyUrl: '请填写远程地址',
      refresh: '刷新',
      onlineSince: '在线时长',
      tokenConfigured: '已配置',
      tokenNotConfigured: '未配置',
      advanced: '身份与诊断',
      identityHint: 'Harness 身份和私钥保存在本机 DSH 数据目录，不会上传到 Relay。',
      stateUnknown: '未知状态',
    };

    const en = {
      tabLabel: 'Remote Relay',
      title: 'DSH Remote',
      subtitle: 'Connect this Harness to an HRP v1 relay so paired phones can reach local sessions.',
      sectionConnection: 'Relay connection',
      sectionPairing: 'Pair a phone',
      sectionMembers: 'Paired devices',
      labelRelay: 'Remote address',
      labelName: 'Display name',
      labelToken: 'Registration token',
      tokenPlaceholderNew: 'Enter the relay registration token on first connect',
      tokenPlaceholderSaved: 'Saved — leave blank to keep it',
      save: 'Save and connect',
      disconnect: 'Disconnect',
      connect: 'Connect',
      clearToken: 'Clear token',
      tokenSaved: 'Registration token saved',
      createPairing: 'Create pairing code',
      copy: 'Copy',
      copied: 'Copied',
      pairHint: 'Enter this code on the phone. It expires in 5 minutes and can be used once.',
      pairExpires: 'Expires in',
      pairExpired: 'This pairing code has expired. Create a new one.',
      pairBusy: 'The relay already has an unused pairing code. Wait for it to expire.',
      ownerExists: 'An owner device already exists. Pair a new phone from that phone’s “Devices and sharing” menu, or remove the old owner before creating a new owner code.',
      remove: 'Remove',
      confirmRemove: 'Confirm removal',
      cancel: 'Cancel',
      removeWarning: 'The device loses access immediately and must be paired again.',
      removeOwnerWarning: 'This is the owner device. Removing it revokes access immediately; if it is the last owner you can create a new owner pairing code afterwards.',
      memberRemoved: 'Device removed',
      stateOnline: 'Online',
      stateConnecting: 'Connecting',
      stateHandshaking: 'Handshaking',
      stateDisconnected: 'Disconnected',
      stateError: 'Connection error',
      harnessId: 'Harness ID',
      aclVersion: 'ACL version',
      noMembers: 'No paired devices yet. Create a pairing code, then pair the phone.',
      roleOwner: 'Owner',
      roleMember: 'Member',
      userId: 'User',
      deviceId: 'Device',
      error: 'Operation failed',
      saved: 'Settings saved',
      emptyUrl: 'Enter a remote address',
      refresh: 'Refresh',
      onlineSince: 'Online for',
      tokenConfigured: 'Configured',
      tokenNotConfigured: 'Not configured',
      advanced: 'Identity and diagnostics',
      identityHint: 'The Harness identity and private key stay in the local DSH data directory and are never uploaded to the relay.',
      stateUnknown: 'Unknown',
    };

    const css = `
      .dshr-page { width: 100%; max-width: 780px; padding: 8px 0 40px; box-sizing: border-box; color: var(--dsw-alias-label-primary); }
      .dshr-head { margin: 0 0 22px; }
      .dshr-title { margin: 0 0 6px; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
      .dshr-subtitle { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
      .dshr-card { border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); margin: 0 0 16px; overflow: hidden; }
      .dshr-cardHead { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 10px; }
      .dshr-cardTitle { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
      .dshr-cardBody { padding: 0 16px 16px; }
      .dshr-badge { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 12px; line-height: 18px; font-weight: 500; white-space: nowrap; }
      .dshr-badge::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
      .dshr-badge[data-state="online"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
      .dshr-badge[data-state="connecting"], .dshr-badge[data-state="handshaking"] { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
      .dshr-badge[data-state="error"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
      .dshr-badge[data-state="disconnected"] { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
      .dshr-row { display: flex; flex-direction: column; gap: 6px; margin: 0 0 14px; }
      .dshr-row:last-child { margin-bottom: 0; }
      .dshr-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
      .dshr-input { width: 100%; height: 36px; padding: 0 10px; box-sizing: border-box; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; outline: none; }
      .dshr-input:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
      .dshr-input::placeholder { color: var(--dsw-alias-state-idle-primary); }
      .dshr-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dshr-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
      .dshr-button { height: 32px; padding: 0 12px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
      .dshr-button:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary); }
      .dshr-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dshr-button:disabled { opacity: 0.55; cursor: default; }
      .dshr-button[data-primary="true"] { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
      .dshr-button[data-danger="true"] { color: var(--dsw-alias-state-error-primary); }
      .dshr-notice { margin-top: 12px; padding: 9px 11px; border-radius: 8px; font-size: 12px; line-height: 18px; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
      .dshr-error { margin-top: 12px; padding: 9px 11px; border-radius: 8px; font-size: 12px; line-height: 18px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
      .dshr-meta { display: grid; grid-template-columns: minmax(96px, max-content) 1fr; gap: 8px 16px; margin: 14px 0 0; padding-top: 14px; border-top: 0.5px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 18px; }
      .dshr-meta dt { color: var(--dsw-alias-label-secondary); }
      .dshr-meta dd { margin: 0; color: var(--dsw-alias-label-primary); min-width: 0; overflow-wrap: anywhere; }
      .dshr-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
      .dshr-pairCode { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0; padding: 12px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l1); }
      .dshr-pairCode code { flex: 1; min-width: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 16px; letter-spacing: 0.16em; line-height: 24px; color: var(--dsw-alias-label-primary); word-break: break-all; }
      .dshr-pairMeta { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dshr-member { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 10px 0; border-top: 0.5px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 18px; }
      .dshr-memberSide { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
      .dshr-buttonSmall { height: 26px; padding: 0 8px; font-size: 12px; }
      .dshr-memberConfirm { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .dshr-warning { grid-column: 1 / -1; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; padding-top: 4px; }
      .dshr-member:first-child { border-top: 0; padding-top: 0; }
      .dshr-memberId { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
      .dshr-memberRole { color: var(--dsw-alias-label-secondary); text-align: right; }
      .dshr-empty { padding: 8px 0 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
      .dshr-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
      @media (max-width: 560px) {
        .dshr-cardHead { padding: 12px 12px 8px; }
        .dshr-cardBody { padding: 0 12px 12px; }
        .dshr-meta { grid-template-columns: 1fr; gap: 2px; }
      }
    `;

    function translateFor(locale) {
      const active = locale?.getSnapshot?.().active;
      const dict = active === 'zh' ? zh : en;
      return (key, vars) => {
        let text = dict[key] ?? en[key] ?? key;
        if (vars) {
          for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
        }
        return text;
      };
    }

    function remainingLabel(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    function onlineLabel(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m`;
      return `${total}s`;
    }

    function stateView(status, t) {
      if (!status) return { key: 'disconnected', text: t('stateUnknown') };
      if (status.state === 'online') return { key: 'online', text: t('stateOnline') };
      if (status.state === 'connecting') return { key: 'connecting', text: t('stateConnecting') };
      if (status.state === 'handshaking') return { key: 'handshaking', text: t('stateHandshaking') };
      if (status.lastError) return { key: 'error', text: t('stateError') };
      return { key: 'disconnected', text: t('stateDisconnected') };
    }

    function callFor(ctx, t) {
      return async function call(endpoint, payload) {
        const connection = ctx.get('connection');
        if (!connection?.rpc?.call) throw new Error(t('error'));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          const full = await connection.rpc.call('/dsh-remote', endpoint, payload ?? null, controller.signal);
          if (!full?.ok) {
            const message = full?.error?.message || full?.error?.code || t('error');
            throw new Error(message);
          }
          return full.value;
        } finally {
          clearTimeout(timer);
        }
      };
    }

    function Field(props) {
      return h('label', { className: 'dshr-row' },
        h('span', { className: 'dshr-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'dshr-hint' }, props.hint) : null,
      );
    }

    function Card(props) {
      return h('section', { className: 'dshr-card' },
        h('div', { className: 'dshr-cardHead' },
          h('h3', { className: 'dshr-cardTitle' }, props.title),
          props.action || null,
        ),
        h('div', { className: 'dshr-cardBody' }, props.children),
      );
    }

    function SettingsView({ ctx, t }) {
      const call = React.useMemo(() => callFor(ctx, t), [ctx, t]);
      const [status, setStatus] = React.useState(null);
      const [config, setConfig] = React.useState({ relayUrl: '', displayName: '', tokenConfigured: false });
      const [form, setForm] = React.useState({ relayUrl: '', displayName: '', token: '' });
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const [confirmDevice, setConfirmDevice] = React.useState('');
      const [now, setNow] = React.useState(Date.now());
      const [, forceLocale] = React.useReducer((value) => value + 1, 0);

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('status');
          setStatus(next);
          return next;
        } catch (err) {
          setError(err.message || String(err));
          return null;
        }
      }, [call]);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const [cfg, st] = await Promise.all([call('config'), call('status')]);
            if (!alive) return;
            setConfig(cfg);
            setStatus(st);
            setForm({ relayUrl: cfg.relayUrl || '', displayName: cfg.displayName || '', token: '' });
          } catch (err) {
            if (alive) setError(err.message || String(err));
          }
        })();
        const unsubscribe = ctx.locale?.subscribe?.(() => forceLocale());
        const timer = setInterval(() => { if (alive) refresh(); }, 2500);
        const clock = setInterval(() => setNow(Date.now()), 1000);
        return () => {
          alive = false;
          clearInterval(timer);
          clearInterval(clock);
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [call, ctx, refresh, forceLocale]);

      const run = async (name, operation) => {
        setBusy(name);
        setError('');
        setNotice('');
        try {
          await operation();
        } catch (err) {
          setError(err.message || String(err));
        } finally {
          setBusy('');
        }
      };

      const saveAndConnect = () => run('save', async () => {
        if (!form.relayUrl.trim()) throw new Error(t('emptyUrl'));
        await call('configure', {
          relayUrl: form.relayUrl.trim(),
          displayName: form.displayName.trim(),
          ...(form.token.trim() ? { registrationToken: form.token.trim() } : {}),
        });
        setForm((value) => ({ ...value, token: '' }));
        setConfig((value) => ({ ...value, relayUrl: form.relayUrl.trim(), displayName: form.displayName.trim(), tokenConfigured: config.tokenConfigured || Boolean(form.token.trim()) }));
        setNotice(t('saved'));
        await call('connect');
        await refresh();
      });

      const disconnect = () => run('disconnect', async () => {
        await call('disconnect');
        await refresh();
      });

      const clearToken = () => run('token', async () => {
        await call('configure', { registrationToken: '' });
        setConfig((value) => ({ ...value, tokenConfigured: false }));
        setNotice(t('tokenSaved'));
        await refresh();
      });

      const createPairing = () => run('pair', async () => {
        try {
          await call('pair.create');
        } catch (err) {
          if (/AGENT_BUSY|already|busy/i.test(err.message || '')) throw new Error(t('pairBusy'));
          throw err;
        }
        await refresh();
      });

      const removeMember = (deviceId) => run('remove', async () => {
        await call('members.revoke', { deviceId });
        setConfirmDevice('');
        setNotice(t('memberRemoved'));
        await refresh();
      });

      const copyCode = async (code) => {
        try {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setNotice(t('copied'));
          setTimeout(() => setCopied(false), 1800);
        } catch {
          setError(t('error'));
        }
      };

      const statusView = stateView(status, t);
      const pairing = status?.pairing;
      const pairingExpired = pairing ? pairing.expiresAt <= now : false;
      const displayCode = pairing ? String(pairing.code || '').replace(/(.{8})/g, '$1 ').trim() : '';
      const members = status?.members || [];
      const hasOwner = members.some((member) => (member.roles || []).some((role) => role.endsWith('OWNER')));

      return h('div', { className: 'dshr-page' },
        h('header', { className: 'dshr-head' },
          h('h2', { className: 'dshr-title' }, t('title')),
          h('p', { className: 'dshr-subtitle' }, t('subtitle')),
        ),
        h(Card, {
          title: t('sectionConnection'),
          action: h('span', { className: 'dshr-badge', 'data-state': statusView.key, role: 'status' }, statusView.text),
        },
          h(Field, { label: t('labelRelay'), hint: 'ws://127.0.0.1:53214' },
            h('input', {
              className: 'dshr-input',
              type: 'url',
              spellCheck: false,
              value: form.relayUrl,
              placeholder: 'ws://127.0.0.1:53214',
              disabled: busy !== '',
              onChange: (event) => setForm((value) => ({ ...value, relayUrl: event.target.value })),
            }),
          ),
          h(Field, { label: t('labelName') },
            h('input', {
              className: 'dshr-input',
              type: 'text',
              value: form.displayName,
              maxLength: 256,
              disabled: busy !== '',
              onChange: (event) => setForm((value) => ({ ...value, displayName: event.target.value })),
            }),
          ),
          h(Field, {
            label: t('labelToken'),
            hint: config.tokenConfigured ? t('tokenPlaceholderSaved') : t('tokenPlaceholderNew'),
          },
            h('input', {
              className: 'dshr-input',
              type: 'password',
              autoComplete: 'off',
              value: form.token,
              placeholder: config.tokenConfigured ? t('tokenPlaceholderSaved') : t('tokenPlaceholderNew'),
              disabled: busy !== '',
              onChange: (event) => setForm((value) => ({ ...value, token: event.target.value })),
            }),
          ),
          h('div', { className: 'dshr-actions' },
            h('button', { className: 'dshr-button', type: 'button', 'data-primary': 'true', disabled: busy !== '', onClick: saveAndConnect }, busy === 'save' ? '…' : t('save')),
            h('button', { className: 'dshr-button', type: 'button', disabled: busy !== '' || status?.state === 'disconnected' || !status, onClick: disconnect }, busy === 'disconnect' ? '…' : t('disconnect')),
            h('button', { className: 'dshr-button', type: 'button', disabled: busy !== '', onClick: () => run('refresh', refresh) }, busy === 'refresh' ? '…' : t('refresh')),
            config.tokenConfigured ? h('button', { className: 'dshr-button', type: 'button', 'data-danger': 'true', disabled: busy !== '', onClick: clearToken }, t('clearToken')) : null,
          ),
          notice ? h('div', { className: 'dshr-notice', role: 'status' }, notice) : null,
          error ? h('div', { className: 'dshr-error', role: 'alert' }, `${t('error')}: ${error}`) : null,
          h('dl', { className: 'dshr-meta' },
            h('dt', null, t('harnessId')),
            h('dd', { className: 'dshr-mono' }, status?.harnessId || config.harnessId || '—'),
            h('dt', null, t('aclVersion')),
            h('dd', null, status ? String(status.aclVersion ?? 0) : '—'),
            h('dt', null, t('labelToken')),
            h('dd', null, status?.tokenConfigured ? t('tokenConfigured') : t('tokenNotConfigured')),
            status?.onlineSince ? h('dt', null, t('onlineSince')) : null,
            status?.onlineSince ? h('dd', null, onlineLabel(now - status.onlineSince)) : null,
            status?.lastError ? h('dt', null, t('error')) : null,
            status?.lastError ? h('dd', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, status.lastError) : null,
          ),
        ),
        h(Card, {
          title: t('sectionPairing'),
          action: h('button', {
            className: 'dshr-button',
            type: 'button',
            disabled: busy !== '' || status?.state !== 'online' || hasOwner || Boolean(pairing && !pairingExpired),
            onClick: createPairing,
          }, busy === 'pair' ? '…' : t('createPairing')),
        },
          hasOwner
            ? h('p', { className: 'dshr-hint' }, t('ownerExists'))
            : pairing && !pairingExpired
            ? h('div', null,
                h('p', { className: 'dshr-hint' }, t('pairHint')),
                h('div', { className: 'dshr-pairCode' },
                  h('code', { 'aria-label': pairing.code }, displayCode),
                  h('button', { className: 'dshr-button', type: 'button', onClick: () => copyCode(pairing.code) }, copied ? t('copied') : t('copy')),
                ),
                h('div', { className: 'dshr-pairMeta' },
                  h('span', null, `${t('pairExpires')} ${remainingLabel(pairing.expiresAt - now)}`),
                ),
              )
            : h('p', { className: 'dshr-empty' }, pairingExpired ? t('pairExpired') : (status?.state === 'online' ? t('pairHint') : t('stateDisconnected'))),
        ),
        h(Card, { title: `${t('sectionMembers')} (${members.length})` },
          members.length === 0
            ? h('p', { className: 'dshr-empty' }, t('noMembers'))
            : members.map((member) => {
                const owner = (member.roles || []).some((role) => role.endsWith('OWNER'));
                const confirming = confirmDevice === member.deviceId;
                return h('div', { className: 'dshr-member', key: member.deviceId },
                  h('div', null,
                    h('div', { className: 'dshr-memberId' }, member.deviceId),
                    h('div', { className: 'dshr-hint' }, `${t('userId')}: ${member.userId || '—'}`),
                  ),
                  h('div', { className: 'dshr-memberSide' },
                    h('div', { className: 'dshr-memberRole' },
                      (member.roles || []).map((role) => role.endsWith('OWNER') ? t('roleOwner') : t('roleMember')).join(' · ') || t('roleMember'),
                    ),
                    confirming
                      ? h('div', { className: 'dshr-memberConfirm' },
                          h('button', { className: 'dshr-button dshr-buttonSmall', type: 'button', 'data-danger': 'true', disabled: busy !== '', onClick: () => removeMember(member.deviceId) }, busy === 'remove' ? '…' : t('confirmRemove')),
                          h('button', { className: 'dshr-button dshr-buttonSmall', type: 'button', disabled: busy !== '', onClick: () => setConfirmDevice('') }, t('cancel')),
                        )
                      : h('button', { className: 'dshr-button dshr-buttonSmall', type: 'button', disabled: busy !== '', onClick: () => setConfirmDevice(member.deviceId) }, t('remove')),
                  ),
                  confirming ? h('div', { className: 'dshr-warning' }, owner ? t('removeOwnerWarning') : t('removeWarning')) : null,
                );
              }),
        ),
        h('p', { className: 'dshr-hint' }, t('identityHint')),
      );
    }

    return {
      name: '@local/dsh-remote',
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const locale = ctx.get('locale');
        const t = () => translateFor(locale);
        ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-remote: locale');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = NS;
          style.textContent = css;
          document.head.append(style);
          return () => style.remove();
        }, 'dsh-remote: styles');
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dsh-remote',
          order: 30,
          label: () => t()('tabLabel'),
        }, (props) => h(SettingsView, { ...props, ctx, t: t() })));
      },
    };
  },
});
