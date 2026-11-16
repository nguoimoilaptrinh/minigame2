// Game 1: Ma Sói v3.2 — một phòng cố định, snapshot host, nhật ký ván, tự nối lại ván khi F5 / mất mạng
window.WerewolfGame = (() => {
  const { WEREWOLF_ROLES, getRecommendedWerewolfRoles, getRandomAvatarId } = window.GameData;

  const SNAPSHOT_KEY = 'hq_ww_host_snapshot';
  const LAST_GAME_KEY = 'hq_ww_last_game';
  const LOG_CAP = 500;
  const RESUME_PREFIX = 'Bot Quản Trò đã kết nối lại. ';
  const JOIN_THROTTLE_MS = 1500;

  let session = null;
  let isHost = false;
  let myName = '';
  let myAvatarId = '';
  let state = null;
  let clientSecret = null; // { roleId, teammates: [], loverInfo: null, converted, startRoleId }
  let witchInfo = null;
  let alphaInfo = null;
  let seerResult = null;
  let wolfSync = { wolfVotes: {}, wolfCount: 1, lock: null }; // WW_WOLF_SYNC mới nhất
  let wolfLockEndLocal = 0; // mốc đồng hồ máy này mà khóa 3 giây của Sói sẽ chốt
  let cardRevealed = false;
  let cardHasNews = false;
  let newsNotifiedSig = '';
  let peekTimer = null;
  let selectedHunterTarget = null;
  let clientVoteLockEnd = 0;
  let playerTickTimer = null;
  let hostTickTimer = null;
  let lastReceivedSeq = -1;
  let lastJoinSentAt = 0;
  let lastHostSceneKey = '';
  let lastPlayerSceneKey = '';

  // Host-only timers & guards
  let hostStepTimer = null;
  let speechGuardTimer = null;
  let speechPrefix = '';
  let stepResolved = false;
  let autoRolesMode = true;
  let demoCounter = 1;
  let selectedNightTarget = null;
  let selectedCupidTargets = [];
  let witchSaveChoice = false;
  let witchPoisonChoice = null;
  let voteAllAnnounced = false;

  // Mốc thời gian cho các bước chờ (đều suy ra từ state đã lưu nên sống sót qua F5)
  const WOLF_LOCK_MS = 3000;
  const WOLF_NUDGE_MS = 40000;
  const WOLF_MAJORITY_MS = 75000;
  const SEER_SAFETY_MS = 12000;
  const REMIND_AT_MS = [35000, 90000];
  const VOTE_LOCK_MS = 8000;
  const timers = {}; // name -> timeout id (xem armTimer / clearTimers)

  const STEP_CALL_NAME = {
    cupid: 'Thần Tình Yêu',
    guard: 'Bảo Vệ',
    werewolf: 'Ma Sói',
    alpha_wolf: 'Sói Đầu Đàn',
    seer: 'Tiên Tri',
    witch: 'Phù Thủy',
    serial_killer: 'Sát Nhân Độc Hành',
    hunter: 'Thợ Săn'
  };

  // ==================== HELPERS ====================
  function isWolfRole(roleId) {
    return roleId === 'werewolf' || roleId === 'alpha_wolf';
  }

  function getPlayerSide(roleId) {
    if (isWolfRole(roleId)) return 'werewolf';
    if (roleId === 'jester' || roleId === 'serial_killer') return roleId;
    return 'villager';
  }

  function storeKey(base) {
    const rn = window.RoomNetwork;
    return rn && typeof rn.storageKey === 'function' ? rn.storageKey(base) : base;
  }

  function lsGet(base) {
    try {
      return localStorage.getItem(storeKey(base));
    } catch (_) {
      return null;
    }
  }

  function lsSet(base, value) {
    try {
      localStorage.setItem(storeKey(base), value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function lsRemove(base) {
    try {
      localStorage.removeItem(storeKey(base));
    } catch (_) {}
  }

  function newEpoch() {
    return `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  function byId(id) {
    return state ? state.players.find((p) => p.id === id) : undefined;
  }

  function roleNameOf(p) {
    return (p && WEREWOLF_ROLES[p.roleId] && WEREWOLF_ROLES[p.roleId].name) || '?';
  }

  function describe(p) {
    return p ? `${p.name} (${roleNameOf(p)})` : '?';
  }

  function clearTimers() {
    Object.keys(timers).forEach((k) => {
      clearTimeout(timers[k]);
      delete timers[k];
    });
  }

  function armTimer(name, ms, fn) {
    if (timers[name]) clearTimeout(timers[name]);
    timers[name] = setTimeout(() => {
      delete timers[name];
      if (!state || !isHost) return;
      fn();
    }, Math.max(0, Math.round(ms)));
  }

  function clearHostTimers() {
    if (hostStepTimer) {
      clearTimeout(hostStepTimer);
      hostStepTimer = null;
    }
    if (speechGuardTimer) {
      clearTimeout(speechGuardTimer);
      speechGuardTimer = null;
    }
    clearTimers();
  }

  function vibrate(pattern) {
    try {
      if (typeof navigator !== 'undefined' && navigator && 'vibrate' in navigator) navigator.vibrate(pattern);
    } catch (_) {}
  }

  function createNightActions() {
    return {
      cupidTargets: [],
      guardTarget: null,
      wolfVotes: {},
      wolfLock: null, // { targetId, endsAt }
      wolfStartedAt: null,
      wolfFirstPickAt: null,
      wolfNudged: false,
      seerResultAt: null,
      wolfTarget: null,
      alphaConvert: false,
      seerTarget: null,
      seerInspected: false,
      witchSave: false,
      witchPoisonTarget: null,
      serialKillerTarget: null
    };
  }

  function createInitialHostState() {
    return {
      stateSeq: 0,
      roomCode: window.RoomNetwork.ROOM_ID,
      epoch: newEpoch(),
      phase: 'LOBBY', // LOBBY | ROLE_REVEAL | NIGHT | HUNTER_REVENGE | DAY | GAME_OVER
      nightNumber: 0,
      nightStep: null, // 'cupid' | 'guard' | 'werewolf' | 'alpha_wolf' | 'seer' | 'witch' | 'serial_killer'
      players: [], // { id, name, avatarId, ready, alive, isDemo, roleId (host-only), startRoleId (host-only until game over) }
      rolesConfig: getRecommendedWerewolfRoles(5),
      lastGuardedId: null,
      seerHistory: [],
      lovers: [], // [id1, id2]
      alphaWolfConvertUsed: false,
      elderLivesMap: {},
      witchPotions: { save: true, poison: true },
      nightActions: createNightActions(),
      dayVotes: {}, // { voterId: targetId | '__skip__' }
      gameNo: 0, // tăng mỗi ván mới (để phone biết "thẻ có tin mới" theo từng ván)
      voteLock: null, // { endsAt, kind: 'lynch'|'skip', targetId } — đếm ngược tự chốt phiếu
      voteLockPaused: false,
      revoteUsed: false,
      stepWatch: null, // { key, startedAt, level } — nhắc người chơi chưa thao tác
      queuedHunterShot: null, // { hunterId, targetId } — phát bắn tới sớm khi Bot còn đang đọc
      pendingHunterId: null,
      pendingHunterNext: null, // 'DAY' | 'NEXT_NIGHT'
      hunterQueue: [], // thợ săn chết cùng đợt đang chờ tới lượt bắn
      botText: 'Chờ tất cả người chơi vào phòng và ấn Sẵn sàng...',
      lastDawnSummary: '',
      winner: null,
      logs: [], // { seq, round, phase, icon, text, secret }
      logSeq: 0,
      deaths: {}, // { playerId: { round, phase: 'night'|'day', cause } }
      flow: { key: 'lobby', data: {} } // điểm chờ hiện tại của Bot (để resume sau F5)
    };
  }

  function getPublicState(s) {
    const revealAll = s.phase === 'GAME_OVER';
    const deaths = {};
    Object.entries(s.deaths || {}).forEach(([id, d]) => {
      deaths[id] = revealAll ? { round: d.round, phase: d.phase, cause: d.cause } : { round: d.round, phase: d.phase };
    });
    return {
      stateSeq: s.stateSeq,
      roomCode: s.roomCode,
      epoch: s.epoch,
      phase: s.phase,
      nightNumber: s.nightNumber,
      nightStep: s.nightStep,
      rolesConfig: s.rolesConfig,
      lastGuardedId: s.lastGuardedId,
      seerHistory: s.seerHistory || [],
      dayVotes: s.dayVotes,
      gameNo: s.gameNo || 0,
      revoteUsed: Boolean(s.revoteUsed),
      voteLock:
        s.voteLock && s.phase === 'DAY'
          ? {
              remainingMs: Math.max(0, s.voteLock.endsAt - Date.now()),
              kind: s.voteLock.kind,
              targetId: s.voteLock.targetId || null
            }
          : null,
      pendingHunterId: s.pendingHunterId,
      botText: s.botText,
      lastDawnSummary: s.lastDawnSummary,
      winner: s.winner,
      lovers: revealAll ? s.lovers || [] : [],
      alphaWolfConvertUsed: Boolean(s.alphaWolfConvertUsed),
      logs: revealAll ? s.logs : s.logs.filter((e) => !e.secret),
      deaths,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatarId: p.avatarId || 'boy_smile',
        ready: p.ready,
        alive: p.alive,
        isDemo: p.isDemo,
        online: p.isDemo ? true : Boolean(session && session.isClientOnline && session.isClientOnline(p.id)),
        roleId: revealAll ? p.roleId : null,
        startRoleId: revealAll ? p.startRoleId || p.roleId : null
      }))
    };
  }

  // ==================== SNAPSHOT / FLOW ====================
  function persistHost() {
    if (!isHost || !state) return;
    try {
      localStorage.setItem(
        storeKey(SNAPSHOT_KEY),
        JSON.stringify({
          v: 1,
          savedAt: Date.now(),
          state,
          autoRolesMode,
          demoCounter,
          stepResolved,
          voteAllAnnounced
        })
      );
    } catch (_) {}
  }

  function readHostSnapshot() {
    const raw = lsGet(SNAPSHOT_KEY);
    if (!raw) return null;
    try {
      const snap = JSON.parse(raw);
      if (snap && snap.state && Array.isArray(snap.state.players) && typeof snap.state.phase === 'string') {
        return snap;
      }
    } catch (_) {}
    return null;
  }

  function getHostSnapshotInfo() {
    const snap = readHostSnapshot();
    if (!snap) return null;
    return { phase: snap.state.phase, playerCount: snap.state.players.length, savedAt: snap.savedAt || 0 };
  }

  function discardHostSnapshot() {
    lsRemove(SNAPSHOT_KEY);
  }

  // Đánh dấu điểm Bot đang chờ — luôn gọi SAU khi state đã đổi xong và TRƯỚC khi Bot nói.
  function setFlow(key, data = {}) {
    if (!state) return;
    state.flow = { key, data };
    persistHost();
  }

  function saveLastGame() {
    try {
      localStorage.setItem(
        storeKey(LAST_GAME_KEY),
        JSON.stringify({
          finishedAt: Date.now(),
          winner: state.winner,
          players: state.players.map((p) => ({
            id: p.id,
            name: p.name,
            avatarId: p.avatarId,
            alive: p.alive,
            roleId: p.roleId,
            startRoleId: p.startRoleId || p.roleId
          })),
          lovers: state.lovers || [],
          deaths: state.deaths || {},
          logs: state.logs
        })
      );
    } catch (_) {}
  }

  function syncStateToClients() {
    if (!isHost || !session || !state) return;
    state.stateSeq += 1;
    persistHost();
    if (typeof session.setBeaconInfo === 'function') {
      session.setBeaconInfo({ phase: state.phase, stateSeq: state.stateSeq, epoch: state.epoch });
    }
    session.send('WW_STATE', getPublicState(state));
  }

  // ==================== SECRETS & PROMPT DATA ====================
  function sendSecretToPlayer(player) {
    if (!isHost || !session || !player || !player.roleId || player.isDemo) return;
    const teammates = isWolfRole(player.roleId)
      ? state.players
          .filter((p) => isWolfRole(p.roleId) && p.id !== player.id)
          .map((p) => ({ id: p.id, name: p.name, avatarId: p.avatarId, alive: p.alive }))
      : [];
    let loverInfo = null;
    if (Array.isArray(state.lovers) && state.lovers.length === 2 && state.lovers.includes(player.id)) {
      const partnerId = state.lovers.find((id) => id !== player.id);
      const partner = byId(partnerId);
      if (partner) {
        loverInfo = {
          id: partner.id,
          name: partner.name,
          avatarId: partner.avatarId,
          alive: partner.alive,
          roleName: WEREWOLF_ROLES[partner.roleId]?.name || '?',
          roleIcon: WEREWOLF_ROLES[partner.roleId]?.icon || '',
          sameSide: getPlayerSide(partner.roleId) === getPlayerSide(player.roleId)
        };
      }
    }
    session.send(
      'WW_SECRET',
      {
        roleId: player.roleId,
        startRoleId: player.startRoleId || player.roleId,
        converted: Boolean(player.startRoleId && player.startRoleId !== player.roleId),
        teammates,
        loverInfo
      },
      player.id
    );
  }

  function sendAlphaInfoTo(alphaPlayer) {
    const victimId = state.nightActions.wolfTarget;
    const victim = victimId ? byId(victimId) : null;
    session.send(
      'WW_ALPHA_INFO',
      {
        victimId: victim ? victim.id : null,
        victimName: victim ? victim.name : null,
        canConvert: !state.alphaWolfConvertUsed && Boolean(victim)
      },
      alphaPlayer.id
    );
  }

  function sendWitchInfoTo(witchPlayer) {
    const victimId = state.witchPotions.save ? state.nightActions.wolfTarget : null;
    const victim = victimId ? byId(victimId) : null;
    session.send(
      'WW_WITCH_INFO',
      {
        victimId: victim ? victim.id : null,
        victimName: victim ? victim.name : null,
        canSave: state.witchPotions.save,
        canPoison: state.witchPotions.poison
      },
      witchPlayer.id
    );
  }

  function sendSeerResultTo(seerPlayer) {
    const na = state.nightActions;
    const target = na.seerInspected && na.seerTarget ? byId(na.seerTarget) : null;
    if (!target) return;
    session.send(
      'WW_SEER_RESULT',
      { targetId: target.id, targetName: target.name, isWolf: isWolfRole(target.roleId) },
      seerPlayer.id
    );
  }

  function aliveWolves() {
    return state.players.filter((p) => p.alive && isWolfRole(p.roleId));
  }

  function isValidPrey(id) {
    return Boolean(id) && state.players.some((p) => p.id === id && p.alive && !isWolfRole(p.roleId));
  }

  function sendWolfSync(wolfPlayer) {
    const na = state.nightActions;
    const wolves = aliveWolves();
    const ids = new Set(wolves.map((w) => w.id));
    const votes = {};
    Object.entries(na.wolfVotes || {}).forEach(([wId, tId]) => {
      if (ids.has(wId)) votes[wId] = tId;
    });
    session.send(
      'WW_WOLF_SYNC',
      {
        wolfVotes: votes,
        wolfCount: Math.max(1, wolves.length),
        lock: na.wolfLock ? { targetId: na.wolfLock.targetId, remainingMs: Math.max(0, na.wolfLock.endsAt - Date.now()) } : null
      },
      wolfPlayer.id
    );
  }

  function sendWolfSyncAll() {
    if (!session) return;
    aliveWolves()
      .filter((w) => !w.isDemo)
      .forEach((w) => sendWolfSync(w));
  }

  // Dữ liệu của bước đêm đang mở mà vai này cần (dùng khi bước bắt đầu hoặc khi người chơi nối lại).
  function sendPendingPromptData(player) {
    if (!player || player.isDemo || !player.alive) return;
    if (state.phase !== 'NIGHT' || stepResolved) return;
    const step = state.nightStep;
    if (step === 'witch' && player.roleId === 'witch') sendWitchInfoTo(player);
    else if (step === 'alpha_wolf' && player.roleId === 'alpha_wolf') sendAlphaInfoTo(player);
    else if (step === 'seer' && player.roleId === 'seer') sendSeerResultTo(player);
    else if (step === 'werewolf' && isWolfRole(player.roleId)) sendWolfSync(player);
  }

  function resyncPlayer(player, broadcast) {
    if (broadcast) syncStateToClients();
    else session.send('WW_STATE', getPublicState(state), player.id);
    if (state.phase !== 'LOBBY') {
      sendSecretToPlayer(player);
      sendPendingPromptData(player);
    }
  }

  // ==================== LOG ====================
  function derivePhase() {
    if (!state) return 'setup';
    if (state.phase === 'NIGHT') return 'night';
    if (state.phase === 'DAY' || state.phase === 'HUNTER_REVENGE') return 'day';
    if (state.phase === 'GAME_OVER') return 'end';
    return 'setup';
  }

  // "A, B và C" thay vì "A và B và C"
  function joinNames(list) {
    const arr = (list || []).filter(Boolean);
    if (arr.length <= 1) return arr.join('');
    return `${arr.slice(0, -1).join(', ')} và ${arr[arr.length - 1]}`;
  }

  function addLog(text, { icon = '•', secret = false, phase } = {}) {
    if (!state) return;
    state.logSeq = (state.logSeq || 0) + 1;
    state.logs.push({
      seq: state.logSeq,
      round: state.nightNumber || 0,
      phase: phase || derivePhase(),
      icon,
      text,
      secret: Boolean(secret)
    });
    if (state.logs.length > LOG_CAP) state.logs.splice(0, state.logs.length - LOG_CAP);
  }

  function describeDayVotes() {
    const parts = [];
    Object.entries(state.dayVotes || {}).forEach(([vId, tId]) => {
      const voter = byId(vId);
      if (!voter) return;
      const target = tId === '__skip__' ? null : byId(tId);
      parts.push(`${voter.name} → ${tId === '__skip__' ? 'bỏ trắng' : target ? target.name : '?'}`);
    });
    return parts.join('; ');
  }

  // ==================== BOT SPEECH ====================
  function setBotSpeech(text, onDone) {
    if (speechGuardTimer) {
      clearTimeout(speechGuardTimer);
      speechGuardTimer = null;
    }
    if (speechPrefix) {
      text = speechPrefix + text;
      speechPrefix = '';
    }

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (speechGuardTimer) {
        clearTimeout(speechGuardTimer);
        speechGuardTimer = null;
      }
      if (!state || !isHost) return;
      if (typeof onDone === 'function') onDone();
    };

    state.botText = text;
    renderHost();
    syncStateToClients();

    // Chốt an toàn: ván chơi không bao giờ bị treo nếu giọng đọc bị chặn/ngắt.
    const holdMs = Math.min(32000, Math.max(6000, String(text || '').length * 105));
    speechGuardTimer = setTimeout(finish, holdMs);
    window.AudioEngine.speak(text, finish);
  }

  // ==================== ENTRY POINTS ====================
  function startHost({ resume = false } = {}) {
    cleanup();
    isHost = true;

    const snap = resume ? readHostSnapshot() : null;
    if (snap) {
      state = { ...createInitialHostState(), ...snap.state };
      if (!state.epoch) state.epoch = newEpoch();
      state.nightActions = { ...createNightActions(), ...(state.nightActions || {}) };
      state.roomCode = window.RoomNetwork.ROOM_ID;
      autoRolesMode = snap.autoRolesMode !== false;
      demoCounter = snap.demoCounter || 1;
      stepResolved = Boolean(snap.stepResolved);
      voteAllAnnounced = Boolean(snap.voteAllAnnounced);
    } else {
      autoRolesMode = true;
      demoCounter = 1;
      stepResolved = false;
      voteAllAnnounced = false;
      state = createInitialHostState();
    }

    session = window.RoomNetwork.createSession({
      gameType: 'werewolf',
      isHost: true,
      onMessage: handleHostMessage,
      onStatus: (txt, ok) => updateNetBadge('ww-host-net-status', txt, ok),
      onPresence: () => {
        if (!state || !isHost) return;
        syncStateToClients();
        renderHost();
      },
      onSuperseded: () => {
        window.AppUI.showToast?.('Máy khác đã tiếp quản vai trò Quản Trò.');
        window.AppUI.clearSession?.();
        cleanup();
        window.AppUI.goHome();
      }
    });
    if (typeof session.setBeaconInfo === 'function') {
      session.setBeaconInfo({ phase: state.phase, stateSeq: state.stateSeq, epoch: state.epoch });
    }
    window.AppUI.markSession?.('host', 'werewolf');

    bindHostEvents();
    renderHostShareBox();
    renderHost();
    window.AppUI.showView('view-werewolf-host');

    if (snap) {
      syncStateToClients();
      resumeHostFlow();
    } else {
      persistHost();
    }
  }

  function joinAsPlayer(playerName, playerAvatarId) {
    cleanup();
    isHost = false;
    myName = playerName;
    myAvatarId = playerAvatarId || window.AppUI.getSavedAvatarId();
    resetClientLocalState();
    lastReceivedSeq = -1;
    lastJoinSentAt = 0;

    state = createInitialHostState();
    state.epoch = null; // chưa biết epoch của host

    session = window.RoomNetwork.createSession({
      gameType: 'werewolf',
      isHost: false,
      onMessage: handleClientMessage,
      onStatus: (txt, ok) => updateNetBadge('ww-pl-net-status', txt, ok),
      onConnected: () => announceJoin(true),
      onBeacon: (b) => {
        if (!state || !b || b.game !== 'werewolf') return;
        if (b.epoch !== state.epoch || b.stateSeq !== lastReceivedSeq) announceJoin(false);
      }
    });
    window.AppUI.markSession?.('player', 'werewolf');

    bindPlayerEvents();
    window.AppUI.showView('view-werewolf-player');
    renderPlayer();
    announceJoin(true);
  }

  function announceJoin(force) {
    if (!session || isHost) return;
    const now = Date.now();
    if (!force && now - lastJoinSentAt < JOIN_THROTTLE_MS) return;
    lastJoinSentAt = now;
    session.send('WW_JOIN', { name: myName, avatarId: myAvatarId });
  }

  function resetClientLocalState() {
    clientSecret = null;
    witchInfo = null;
    alphaInfo = null;
    seerResult = null;
    wolfSync = { wolfVotes: {}, wolfCount: 1, lock: null };
    wolfLockEndLocal = 0;
    cardRevealed = false;
    cardHasNews = false;
    newsNotifiedSig = '';
    if (peekTimer) {
      clearTimeout(peekTimer);
      peekTimer = null;
    }
    selectedNightTarget = null;
    selectedCupidTargets = [];
    selectedHunterTarget = null;
    witchSaveChoice = false;
    witchPoisonChoice = null;
    clientVoteLockEnd = 0;
  }

  // Lưu ý: cleanup() KHÔNG xoá snapshot host và session marker (app router gọi khi đổi game).
  function cleanup() {
    clearHostTimers();
    if (hostTickTimer) {
      clearTimeout(hostTickTimer);
      hostTickTimer = null;
    }
    if (playerTickTimer) {
      clearTimeout(playerTickTimer);
      playerTickTimer = null;
    }
    if (peekTimer) {
      clearTimeout(peekTimer);
      peekTimer = null;
    }
    speechPrefix = '';
    lastHostSceneKey = '';
    lastPlayerSceneKey = '';
    try {
      window.AudioEngine.stopSpeech();
      window.AudioEngine.stopNightAmbience();
    } catch (_) {}
    if (session) {
      session.destroy();
      session = null;
    }
    state = null;
    isHost = false;
  }

  // ==================== HOST MESSAGE HANDLER ====================
  function remapPlayerId(oldId, newId) {
    if (!state || oldId === newId) return;
    const swap = (id) => (id === oldId ? newId : id);
    const swapKeys = (obj) => {
      const out = {};
      Object.entries(obj || {}).forEach(([k, v]) => {
        out[swap(k)] = v;
      });
      return out;
    };
    const p = byId(oldId);
    if (p) p.id = newId;
    state.lovers = (state.lovers || []).map(swap);
    state.lastGuardedId = swap(state.lastGuardedId);
    state.seerHistory = (state.seerHistory || []).map(swap);
    state.elderLivesMap = swapKeys(state.elderLivesMap);
    state.pendingHunterId = swap(state.pendingHunterId);
    state.hunterQueue = (state.hunterQueue || []).map(swap);
    state.deaths = swapKeys(state.deaths);
    const votes = {};
    Object.entries(state.dayVotes || {}).forEach(([k, v]) => {
      votes[swap(k)] = swap(v);
    });
    state.dayVotes = votes;
    if (state.voteLock) state.voteLock.targetId = swap(state.voteLock.targetId);
    if (state.queuedHunterShot) {
      state.queuedHunterShot.hunterId = swap(state.queuedHunterShot.hunterId);
      state.queuedHunterShot.targetId = swap(state.queuedHunterShot.targetId);
    }
    const na = state.nightActions;
    if (na) {
      na.cupidTargets = (na.cupidTargets || []).map(swap);
      na.guardTarget = swap(na.guardTarget);
      const wv = {};
      Object.entries(na.wolfVotes || {}).forEach(([k, v]) => {
        wv[swap(k)] = swap(v);
      });
      na.wolfVotes = wv;
      if (na.wolfLock) na.wolfLock.targetId = swap(na.wolfLock.targetId);
      na.wolfTarget = swap(na.wolfTarget);
      na.seerTarget = swap(na.seerTarget);
      na.witchPoisonTarget = swap(na.witchPoisonTarget);
      na.serialKillerTarget = swap(na.serialKillerTarget);
    }
    state.logs.forEach((e) => {
      if (Array.isArray(e.refs)) e.refs = e.refs.map(swap);
    });
  }

  function handleHostMessage(msg) {
    if (!state || !isHost) return;
    const { senderId, type } = msg;
    const payload = msg.payload || {};

    if (type === 'WW_JOIN') {
      const cleanName = String(payload.name || 'Người chơi').trim().slice(0, 20) || 'Người chơi';
      const avatarId = payload.avatarId || getRandomAvatarId(state.players.length);
      let player = byId(senderId);
      let changed = false;

      if (!player) {
        if (state.phase !== 'LOBBY') {
          // Đổi máy / đổi trình duyệt: cùng tên, id mới, và chủ cũ không còn online.
          const byName = state.players.find((p) => p.name.toLowerCase() === cleanName.toLowerCase() && !p.isDemo);
          if (byName && !(session.isClientOnline && session.isClientOnline(byName.id))) {
            remapPlayerId(byName.id, senderId);
            if (payload.avatarId) byName.avatarId = payload.avatarId;
            resyncPlayer(byName, true);
            renderHost();
            return;
          }
          // Khán giả: chỉ nhận trạng thái công khai.
          session.send('WW_STATE', getPublicState(state), senderId);
          return;
        }
        player = {
          id: senderId,
          name: cleanName,
          avatarId,
          ready: false,
          alive: true,
          isDemo: false,
          roleId: null
        };
        state.players.push(player);
        if (autoRolesMode && state.players.length >= 5) {
          state.rolesConfig = getRecommendedWerewolfRoles(state.players.length);
        }
        changed = true;
      } else if (state.phase === 'LOBBY') {
        if (player.name !== cleanName || (payload.avatarId && player.avatarId !== payload.avatarId)) changed = true;
        player.name = cleanName;
        if (payload.avatarId) player.avatarId = payload.avatarId;
      }

      resyncPlayer(player, changed);
      renderHost();
      return;
    }

    if (type === 'WW_RENAME') {
      const p = byId(senderId);
      if (p && state.phase === 'LOBBY') {
        p.name = String(payload.name || p.name).trim().slice(0, 20) || p.name;
        if (payload.avatarId) p.avatarId = payload.avatarId;
        syncStateToClients();
        renderHost();
      }
      return;
    }

    if (type === 'WW_READY') {
      const p = byId(senderId);
      if (p && state.phase === 'LOBBY') {
        p.ready = Boolean(payload.ready);
        syncStateToClients();
        renderHost();
      }
      return;
    }

    if (type === 'WW_LEAVE') {
      if (state.phase === 'LOBBY') {
        state.players = state.players.filter((x) => x.id !== senderId);
        if (autoRolesMode && state.players.length >= 5) {
          state.rolesConfig = getRecommendedWerewolfRoles(state.players.length);
        }
        syncStateToClients();
        renderHost();
      }
      return;
    }

    if (type === 'WW_DAY_VOTE' && state.phase === 'DAY') {
      if (!['day', 'dawn'].includes(state.flow && state.flow.key)) return;
      const voter = state.players.find((x) => x.id === senderId && x.alive);
      if (!voter) return;
      const tId = payload.targetId;
      if (tId === '__skip__' || state.players.some((x) => x.id === tId && x.alive && x.id !== senderId)) {
        if (state.dayVotes[senderId] === tId) return; // bấm lại đúng phiếu cũ: không đếm lại
        state.dayVotes[senderId] = tId;
        state.voteLockPaused = false; // có phiếu đổi -> đếm ngược hoạt động lại
        evaluateDayVotes();
        syncStateToClients();
        renderHost();
      }
      return;
    }

    if (type === 'WW_ACTION') {
      handleHostNightOrHunterAction(senderId, payload);
    }
  }

  // ----- Bỏ phiếu ban ngày: tự chốt khi mọi người (thật, còn sống) đã vote -----
  function cancelVoteLock() {
    state.voteLock = null;
    if (timers.voteLock) {
      clearTimeout(timers.voteLock);
      delete timers.voteLock;
    }
  }

  function resetDayVoteState() {
    cancelVoteLock();
    state.voteLockPaused = false;
    state.revoteUsed = false;
    state.dayVotes = {};
  }

  function armVoteLockTimer() {
    const lock = state && state.voteLock;
    if (!lock || state.phase !== 'DAY' || !state.flow || state.flow.key !== 'day') return;
    const endsAt = lock.endsAt;
    armTimer('voteLock', Math.max(300, endsAt - Date.now()), () => {
      const cur = state.voteLock;
      if (!cur || cur.endsAt !== endsAt || state.phase !== 'DAY' || state.flow.key !== 'day') return;
      if (cur.kind === 'lynch' && cur.targetId && byId(cur.targetId) && byId(cur.targetId).alive) lynchPlayer(cur.targetId);
      else skipLynchToNight();
    });
  }

  function tiedNames(tally) {
    return tally.entries
      .filter(([, voters]) => voters.length === tally.topVotes)
      .map(([tId]) => (tId === '__skip__' ? 'phiếu trắng' : (byId(tId) || {}).name || '?'));
  }

  // Gọi mỗi khi một phiếu vừa đổi (hoặc khi sang giai đoạn "day").
  function evaluateDayVotes() {
    if (!state || !isHost || state.phase !== 'DAY' || !state.flow || state.flow.key !== 'day') return;
    const realAlive = state.players.filter((p) => p.alive && !p.isDemo);
    if (realAlive.length === 0) return;
    const allDone = realAlive.every((p) => Boolean(state.dayVotes[p.id]));
    if (!allDone) {
      if (state.voteLock) cancelVoteLock();
      return;
    }
    if (state.voteLockPaused) return;

    const tally = getDayVoteTally();
    if (!tally.leaderId) return;
    const prev = state.voteLock;
    let kind;
    let targetId = null;
    let text;

    if (tally.isTie && !state.revoteUsed) {
      // Hòa lần đầu: bỏ phiếu lại một lần.
      cancelVoteLock();
      state.revoteUsed = true;
      const names = tiedNames(tally);
      state.dayVotes = {};
      addLog(`Hòa phiếu giữa ${joinNames(names)} — cả làng bỏ phiếu lại.`, { icon: '🤝' });
      window.AudioEngine.playVoteGavel();
      setBotSpeech(
        `Hòa phiếu giữa ${joinNames(names)}! Mọi người thảo luận thêm và bỏ phiếu lại — lần này hòa nữa thì không ai bị treo cổ.`
      );
      return;
    }
    if (tally.isTie) {
      kind = 'skip';
      text = 'Hòa phiếu lần nữa! Hôm nay không ai bị treo cổ. Bot sẽ chuyển sang đêm sau 8 giây — ai muốn đổi phiếu thì đổi ngay!';
    } else if (tally.leaderId === '__skip__') {
      kind = 'skip';
      text = 'Đa số bỏ phiếu trắng! Hôm nay không ai bị treo cổ. Bot sẽ chuyển sang đêm sau 8 giây — ai muốn đổi phiếu thì đổi ngay!';
    } else {
      kind = 'lynch';
      targetId = tally.leaderId;
      const leader = byId(targetId);
      text = `Tất cả đã bỏ phiếu! ${leader ? leader.name : ''} đang dẫn đầu với ${tally.topVotes} phiếu. Bot sẽ chốt sau 8 giây — ai muốn đổi phiếu thì đổi ngay!`;
    }

    state.voteLock = { endsAt: Date.now() + VOTE_LOCK_MS, kind, targetId };
    armVoteLockTimer();
    persistHost();
    if (!prev || prev.kind !== kind || prev.targetId !== targetId) {
      window.AudioEngine.playVoteGavel();
      setBotSpeech(text);
    }
  }

  // ==================== HOST GAME LOGIC ====================
  function startNewGame() {
    if (!isHost || !state || state.phase !== 'LOBBY') return;
    window.AudioEngine.unlock();
    clearHostTimers();
    lastHostSceneKey = '';

    const pool = [];
    for (const [roleId, count] of Object.entries(state.rolesConfig)) {
      for (let i = 0; i < count; i++) pool.push(roleId);
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    state.elderLivesMap = {};
    state.players.forEach((p, idx) => {
      p.roleId = pool[idx];
      p.startRoleId = p.roleId;
      p.alive = true;
      if (p.roleId === 'elder') state.elderLivesMap[p.id] = 2;
    });

    state.phase = 'ROLE_REVEAL';
    state.nightNumber = 0;
    state.nightStep = null;
    state.lastGuardedId = null;
    state.seerHistory = [];
    state.lovers = [];
    state.alphaWolfConvertUsed = false;
    state.witchPotions = { save: true, poison: true };
    state.nightActions = createNightActions();
    resetDayVoteState();
    state.gameNo = (state.gameNo || 0) + 1;
    state.stepWatch = null;
    state.queuedHunterShot = null;
    state.pendingHunterId = null;
    state.pendingHunterNext = null;
    state.hunterQueue = [];
    state.winner = null;
    state.logs = [];
    state.logSeq = 0;
    state.deaths = {};
    state.lastDawnSummary = '';
    voteAllAnnounced = false;
    stepResolved = false;

    addLog('Ván chơi Ma Sói mới bắt đầu!', { icon: '🎬', phase: 'setup' });
    addLog(`Chia vai: ${state.players.map((p) => `${p.name} = ${roleNameOf(p)}`).join('; ')}`, {
      icon: '🃏',
      secret: true,
      phase: 'setup'
    });
    setFlow('role_reveal');
    syncStateToClients();
    state.players.forEach((p) => {
      if (!p.isDemo) sendSecretToPlayer(p);
    });
    renderHost();
    runRoleReveal();
  }

  function runRoleReveal() {
    setBotSpeech(
      'Trò chơi Ma Sói bắt đầu! Mọi người hãy nhấn và giữ thẻ bài trên điện thoại để xem vai trò bí mật của mình nhé.',
      () => {
        hostStepTimer = setTimeout(() => {
          if (state && state.phase === 'ROLE_REVEAL') {
            beginNextNight();
          }
        }, 2400);
      }
    );
  }

  // Chỉ gọi đúng một lần cho mỗi đêm (resume 'night_intro' gọi runNightIntro, KHÔNG gọi hàm này).
  function beginNextNight() {
    clearHostTimers();
    state.phase = 'NIGHT';
    state.nightNumber += 1;
    state.nightStep = null;
    resetDayVoteState();
    state.stepWatch = null;
    state.nightActions = createNightActions();
    voteAllAnnounced = false;
    stepResolved = false;
    addLog(`Đêm thứ ${state.nightNumber} bắt đầu.`, { icon: '🌙' });
    setFlow('night_intro');
    runNightIntro();
  }

  function runNightIntro() {
    renderHost();
    setBotSpeech(`Đêm thứ ${state.nightNumber}. Trời tối rồi, xin mời tất cả mọi người nhắm mắt lại!`, () => {
      hostStepTimer = setTimeout(() => advanceNightStep(), 1000);
    });
  }

  function getActiveNightOrder() {
    const order = [];
    if (state.nightNumber === 1 && (state.rolesConfig.cupid || 0) > 0) order.push('cupid');
    if ((state.rolesConfig.guard || 0) > 0) order.push('guard');
    order.push('werewolf');
    if ((state.rolesConfig.alpha_wolf || 0) > 0 && !state.alphaWolfConvertUsed) order.push('alpha_wolf');
    if ((state.rolesConfig.seer || 0) > 0) order.push('seer');
    if ((state.rolesConfig.witch || 0) > 0) order.push('witch');
    if ((state.rolesConfig.serial_killer || 0) > 0) order.push('serial_killer');
    return order;
  }

  function advanceNightStep() {
    clearHostTimers();
    if (!state || state.phase !== 'NIGHT') return;

    const order = getActiveNightOrder();
    const currentIndex = state.nightStep ? order.indexOf(state.nightStep) : -1;
    const nextStep = order[currentIndex + 1];

    if (!nextStep) {
      resolveNightAndStartDay();
      return;
    }

    state.nightStep = nextStep;
    stepResolved = false;
    setFlow('night_step');
    syncStateToClients();
    renderHost();
    runNightStepPrompt(nextStep);
  }

  // ----- Nhắc người chơi chưa thao tác (không bao giờ tự bỏ qua lượt người còn sống) -----
  function ensureWatch(key) {
    if (!state.stepWatch || state.stepWatch.key !== key) {
      state.stepWatch = { key, startedAt: Date.now(), level: 0 };
      persistHost();
    }
  }

  // Người thật còn sống mà Bot đang chờ (null nếu không ai / đã có kết quả).
  function stepWaitingPlayer() {
    if (!state) return null;
    if (state.phase === 'NIGHT' && state.flow && state.flow.key === 'night_step' && !stepResolved) {
      const step = state.nightStep;
      const na = state.nightActions;
      if (step === 'werewolf') {
        if (na.wolfFirstPickAt || na.wolfLock) return null; // đã bấm: lo việc thống nhất
        return aliveWolves().find((w) => !w.isDemo) || null;
      }
      if (step === 'seer' && na.seerInspected) return null; // đã có kết quả: có chốt 12 giây
      if (step === 'alpha_wolf') {
        if (state.alphaWolfConvertUsed || !na.wolfTarget) return null;
      }
      const p = state.players.find((x) => x.alive && x.roleId === step);
      return p && !p.isDemo ? p : null;
    }
    if (state.phase === 'HUNTER_REVENGE' && state.flow && state.flow.key === 'hunter_wait') {
      const h = byId(state.pendingHunterId);
      return h && !h.isDemo ? h : null;
    }
    return null;
  }

  function armReminders() {
    const watch = state && state.stepWatch;
    if (!watch || watch.level >= REMIND_AT_MS.length) return;
    const key = watch.key;
    armTimer('remind', Math.max(3000, watch.startedAt + REMIND_AT_MS[watch.level] - Date.now()), () => {
      const cur = state.stepWatch;
      if (!cur || cur.key !== key) return;
      const waiting = stepWaitingPlayer();
      if (waiting) {
        const step = state.phase === 'HUNTER_REVENGE' ? 'hunter' : state.nightStep;
        setBotSpeech(
          step === 'werewolf'
            ? 'Ma Sói ơi, hãy mở mắt dậy và chọn con mồi đêm nay!'
            : `${STEP_CALL_NAME[step] || 'Bạn'} ơi, hãy thao tác trên điện thoại của mình nhé!`
        );
      }
      cur.level += 1;
      persistHost();
      armReminders();
    });
  }

  // ----- Bầy Sói: "đổ đầy nút", cả bầy chạm cùng một người thì tự chốt sau 3 giây -----
  function wolfTally() {
    const alive = new Set(aliveWolves().map((w) => w.id));
    const tally = {};
    Object.entries(state.nightActions.wolfVotes || {}).forEach(([wId, tId]) => {
      if (alive.has(wId) && isValidPrey(tId)) tally[tId] = (tally[tId] || 0) + 1;
    });
    const max = Math.max(0, ...Object.values(tally));
    return { tally, max, topIds: Object.keys(tally).filter((id) => tally[id] === max && max > 0) };
  }

  function evaluateWolfVotes() {
    if (!state || state.phase !== 'NIGHT' || state.nightStep !== 'werewolf' || stepResolved) return;
    const na = state.nightActions;
    const wolves = aliveWolves();
    const real = wolves.filter((w) => !w.isDemo);
    if (real.length === 0) return;
    const leader = real.find((w) => isValidPrey(na.wolfVotes[w.id]));
    wolves
      .filter((w) => w.isDemo)
      .forEach((d) => {
        if (leader) na.wolfVotes[d.id] = na.wolfVotes[leader.id];
        else delete na.wolfVotes[d.id];
      });
    if (leader && !na.wolfFirstPickAt) na.wolfFirstPickAt = Date.now();
    const picks = wolves.map((w) => na.wolfVotes[w.id]);
    const agreed = picks.length > 0 && picks.every((t) => isValidPrey(t) && t === picks[0]) ? picks[0] : null;
    if (agreed) {
      if (!na.wolfLock || na.wolfLock.targetId !== agreed) {
        na.wolfLock = { targetId: agreed, endsAt: Date.now() + WOLF_LOCK_MS };
      }
    } else {
      na.wolfLock = null;
    }
    persistHost();
    armWolfTimers();
    sendWolfSyncAll();
  }

  function armWolfTimers() {
    if (!state || state.nightStep !== 'werewolf' || !state.flow || state.flow.key !== 'night_step' || stepResolved) return;
    const na = state.nightActions;
    const now = Date.now();
    if (na.wolfLock) {
      const lock = na.wolfLock;
      armTimer('wolfLock', Math.max(400, lock.endsAt - now), () => {
        const cur = state.nightActions.wolfLock;
        if (!cur || cur.endsAt !== lock.endsAt) return;
        finishWerewolfStep(cur.targetId);
      });
    } else if (timers.wolfLock) {
      clearTimeout(timers.wolfLock);
      delete timers.wolfLock;
    }
    if (na.wolfFirstPickAt) {
      if (!na.wolfNudged) {
        armTimer('wolfNudge', Math.max(400, na.wolfFirstPickAt + WOLF_NUDGE_MS - now), () => {
          const cur = state.nightActions;
          if (stepResolved || state.nightStep !== 'werewolf' || cur.wolfNudged || cur.wolfLock) return;
          cur.wolfNudged = true;
          persistHost();
          setBotSpeech('Bầy Sói ơi, hãy thống nhất chọn một con mồi nào!');
        });
      }
      armTimer('wolfMajority', Math.max(400, na.wolfFirstPickAt + WOLF_MAJORITY_MS - now), () => {
        const cur = state.nightActions;
        if (stepResolved || state.nightStep !== 'werewolf' || state.flow.key !== 'night_step') return;
        if (cur.wolfLock) {
          finishWerewolfStep(cur.wolfLock.targetId);
          return;
        }
        const { topIds } = wolfTally();
        if (topIds.length === 0) return; // không ai chọn hợp lệ: không tự chọn
        const tied = topIds.length > 1;
        finishWerewolfStep(
          topIds[Math.floor(Math.random() * topIds.length)],
          tied ? 'Bầy Sói không thống nhất sau 75 giây, hòa phiếu nên Bot chọn ngẫu nhiên trong số bị chọn.' : 'Bầy Sói không thống nhất sau 75 giây, Bot chốt theo đa số.'
        );
      });
    }
  }

  // ----- Tiên Tri: nếu 12 giây sau khi có kết quả vẫn chưa bấm "xong" thì Bot tự đóng lượt -----
  function armSeerSafety() {
    if (!state || state.nightStep !== 'seer' || !state.flow || state.flow.key !== 'night_step' || stepResolved) return;
    const na = state.nightActions;
    if (!na.seerInspected || !na.seerResultAt) return;
    armTimer('seerSafety', Math.max(400, na.seerResultAt + SEER_SAFETY_MS - Date.now()), () => {
      if (stepResolved || state.nightStep !== 'seer' || state.flow.key !== 'night_step') return;
      addLog('Tiên Tri chưa bấm "xong" sau 12 giây — Bot tự đóng lượt.', { icon: '🔮', secret: true });
      finishSeerStep();
    });
  }

  function runNightStepPrompt(step) {
    ensureWatch(`night${state.nightNumber}:${step}`);
    armReminders();
    if (step === 'cupid') runCupidStep();
    else if (step === 'guard') runGuardStep();
    else if (step === 'werewolf') runWerewolfStep();
    else if (step === 'alpha_wolf') runAlphaWolfStep();
    else if (step === 'seer') runSeerStep();
    else if (step === 'witch') runWitchStep();
    else if (step === 'serial_killer') runSerialKillerStep();
  }

  // Kết thúc một bước đêm: Bot đọc lời "nhắm mắt lại" rồi sang bước kế tiếp.
  function closeNightStep(text) {
    setFlow('night_step_done');
    setBotSpeech(text, () => {
      hostStepTimer = setTimeout(() => advanceNightStep(), 900);
    });
  }

  function runCupidStep() {
    const aliveCupid = state.players.find((p) => p.alive && p.roleId === 'cupid');
    setBotSpeech('Thần Tình Yêu ơi, hãy mở mắt dậy và chọn 2 người để ghép thành Cặp Đôi Tình Nhân!', () => {
      if (!aliveCupid) {
        hostStepTimer = setTimeout(() => finishCupidStep([]), 3200);
      } else if (aliveCupid.isDemo) {
        const pool = [...state.players].filter((p) => p.alive);
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        const pair = pool.length >= 2 ? [pool[0].id, pool[1].id] : [];
        hostStepTimer = setTimeout(() => finishCupidStep(pair), 1600);
      }
    });
  }

  function finishCupidStep(targetIds) {
    if (stepResolved || !state || state.phase !== 'NIGHT' || state.nightStep !== 'cupid') return;
    stepResolved = true;
    clearHostTimers();
    const valid = Array.isArray(targetIds)
      ? [...new Set(targetIds)].filter((id) => state.players.some((p) => p.id === id && p.alive)).slice(0, 2)
      : [];
    if (valid.length === 2) {
      state.lovers = valid;
      state.nightActions.cupidTargets = valid;
      const [a, b] = valid.map(byId);
      const cross = getPlayerSide(a.roleId) !== getPlayerSide(b.roleId);
      addLog(
        `Thần Tình Yêu ghép đôi ${describe(a)} và ${describe(b)} — ${cross ? 'KHÁC phe (có thể thành Phe Thứ 3)' : 'cùng phe'}.`,
        { icon: '💘', secret: true }
      );
      valid.forEach((id) => {
        const lp = byId(id);
        if (lp) sendSecretToPlayer(lp);
      });
    } else {
      addLog('Thần Tình Yêu không ghép đôi ai.', { icon: '💘', secret: true });
    }
    closeNightStep('Thần Tình Yêu đã se duyên xong. Xin mời Thần Tình Yêu nhắm mắt lại.');
  }

  function runGuardStep() {
    const aliveGuard = state.players.find((p) => p.alive && p.roleId === 'guard');
    setBotSpeech('Bảo Vệ ơi, hãy mở mắt dậy và chọn một người để bảo vệ đêm nay.', () => {
      if (!aliveGuard) {
        hostStepTimer = setTimeout(() => finishGuardStep(null), 5000 + Math.random() * 2000);
      } else if (aliveGuard.isDemo) {
        const candidates = state.players.filter((p) => p.alive && p.id !== state.lastGuardedId);
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        hostStepTimer = setTimeout(() => finishGuardStep(pick ? pick.id : null), 1600);
      }
    });
  }

  function finishGuardStep(targetId) {
    if (stepResolved || !state || state.phase !== 'NIGHT' || state.nightStep !== 'guard') return;
    stepResolved = true;
    clearHostTimers();
    state.nightActions.guardTarget = targetId;
    state.lastGuardedId = targetId;
    const t = targetId ? byId(targetId) : null;
    addLog(t ? `Bảo Vệ chọn bảo vệ ${describe(t)}.` : 'Bảo Vệ không bảo vệ ai.', { icon: '🛡️', secret: true });
    closeNightStep('Bảo Vệ đã chọn xong. Xin mời Bảo Vệ nhắm mắt lại.');
  }

  function runWerewolfStep() {
    const wolves = aliveWolves();
    const na = state.nightActions;
    if (!na.wolfStartedAt) na.wolfStartedAt = Date.now();
    // Sau khi nối lại: gửi lại các lựa chọn Sói đã bấm và dựng lại khóa/đếm giờ từ state đã lưu.
    if (wolves.some((w) => !w.isDemo)) evaluateWolfVotes();
    setBotSpeech('Ma Sói ơi, hãy mở mắt dậy và chọn con mồi đêm nay!', () => {
      if (wolves.length === 0) {
        // Hết Sói nhưng ván vẫn tiếp diễn (còn Sát Nhân): giả vờ gọi cho đủ nhịp rồi sang bước kế.
        hostStepTimer = setTimeout(() => finishWerewolfStep(null), 5000 + Math.random() * 2000);
      } else if (wolves.every((w) => w.isDemo)) {
        const prey = state.players.filter((p) => p.alive && !isWolfRole(p.roleId));
        const pick = prey[Math.floor(Math.random() * prey.length)];
        hostStepTimer = setTimeout(() => finishWerewolfStep(pick ? pick.id : null), 1800);
      }
    });
  }

  // Dùng cho nút "Bỏ qua bước" của host: đa số phiếu Sói (hòa -> ngẫu nhiên), không có thì lastTargetId.
  function pickMajorityWolfTarget(lastTargetId) {
    const { topIds } = wolfTally();
    if (topIds.length) return topIds[Math.floor(Math.random() * topIds.length)];
    return isValidPrey(lastTargetId) ? lastTargetId : null;
  }

  function finishWerewolfStep(targetId, note) {
    if (stepResolved || !state || state.phase !== 'NIGHT' || state.nightStep !== 'werewolf') return;
    stepResolved = true;
    clearHostTimers();
    const na = state.nightActions;
    na.wolfTarget = targetId;
    na.wolfLock = null;
    const t = targetId ? byId(targetId) : null;
    const votesText = Object.entries(na.wolfVotes || {})
      .filter(([wId]) => !(byId(wId) || {}).isDemo)
      .map(([wId, tId]) => `${(byId(wId) || {}).name || '?'} → ${(byId(tId) || {}).name || '?'}`)
      .join('; ');
    addLog(
      t
        ? `Bầy Sói chốt cắn ${describe(t)}.${votesText ? ` Phiếu Sói: ${votesText}.` : ''}${note ? ` ${note}` : ''}`
        : 'Bầy Sói không chọn được con mồi nào.',
      { icon: '🐺', secret: true }
    );
    closeNightStep('Ma Sói đã chọn xong con mồi. Xin mời Ma Sói nhắm mắt lại.');
  }

  function runAlphaWolfStep() {
    const aliveAlpha = state.players.find((p) => p.alive && p.roleId === 'alpha_wolf');
    if (aliveAlpha && !aliveAlpha.isDemo) {
      sendAlphaInfoTo(aliveAlpha);
    }
    setBotSpeech('Sói Đầu Đàn ơi, bạn có muốn dùng quyền Nguyền biến nạn nhân đêm nay thành Ma Sói không?', () => {
      if (!aliveAlpha || state.alphaWolfConvertUsed || !state.nightActions.wolfTarget) {
        hostStepTimer = setTimeout(() => finishAlphaWolfStep(false), 2600);
      } else if (aliveAlpha.isDemo) {
        hostStepTimer = setTimeout(() => finishAlphaWolfStep(false), 1600);
      }
    });
  }

  function finishAlphaWolfStep(convert) {
    if (stepResolved || !state || state.phase !== 'NIGHT' || state.nightStep !== 'alpha_wolf') return;
    stepResolved = true;
    clearHostTimers();
    const victim = state.nightActions.wolfTarget ? byId(state.nightActions.wolfTarget) : null;
    if (convert && !state.alphaWolfConvertUsed && victim) {
      state.nightActions.alphaConvert = true;
      addLog(`Sói Đầu Đàn quyết định NGUYỀN ${describe(victim)}.`, { icon: '🩸', secret: true });
    } else {
      addLog('Sói Đầu Đàn không dùng quyền Nguyền đêm nay.', { icon: '🩸', secret: true });
    }
    closeNightStep('Sói Đầu Đàn đã quyết định xong. Xin mời Sói Đầu Đàn nhắm mắt lại.');
  }

  function runSeerStep() {
    const aliveSeer = state.players.find((p) => p.alive && p.roleId === 'seer');
    if (aliveSeer && !aliveSeer.isDemo) sendSeerResultTo(aliveSeer);
    armSeerSafety();
    setBotSpeech('Tiên Tri ơi, hãy mở mắt dậy và chọn một người để soi thân phận.', () => {
      if (!aliveSeer) {
        hostStepTimer = setTimeout(() => finishSeerStep(), 5000 + Math.random() * 2000);
      } else if (aliveSeer.isDemo) {
        hostStepTimer = setTimeout(() => finishSeerStep(), 1600);
      }
    });
  }

  function finishSeerStep() {
    if (stepResolved || !state || state.phase !== 'NIGHT' || state.nightStep !== 'seer') return;
    stepResolved = true;
    clearHostTimers();
    closeNightStep('Tiên Tri đã soi xong. Xin mời Tiên Tri nhắm mắt lại.');
  }

  function runWitchStep() {
    window.AudioEngine.playWitchPotion();
    const aliveWitch = state.players.find((p) => p.alive && p.roleId === 'witch');
    if (aliveWitch && !aliveWitch.isDemo) {
      sendWitchInfoTo(aliveWitch);
    }
    setBotSpeech('Phù Thủy ơi, hãy mở mắt dậy để sử dụng bình thuốc của mình.', () => {
      if (!aliveWitch) {
        hostStepTimer = setTimeout(() => finishWitchStep(false, null), 5000 + Math.random() * 2000);
      } else if (aliveWitch.isDemo) {
        hostStepTimer = setTimeout(() => finishWitchStep(false, null), 1600);
      }
    });
  }

  function finishWitchStep(useSave, poisonTargetId) {
    if (stepResolved || !state || state.phase !== 'NIGHT' || state.nightStep !== 'witch') return;
    stepResolved = true;
    clearHostTimers();
    let didSave = false;
    let didPoison = false;
    if (useSave && state.witchPotions.save) {
      state.nightActions.witchSave = true;
      state.witchPotions.save = false;
      didSave = true;
      const v = state.nightActions.wolfTarget ? byId(state.nightActions.wolfTarget) : null;
      addLog(`Phù Thủy dùng Bình Cứu${v ? ` cứu ${describe(v)}` : ' (không có nạn nhân)'}.`, { icon: '💚', secret: true });
    }
    if (poisonTargetId && state.witchPotions.poison) {
      state.nightActions.witchPoisonTarget = poisonTargetId;
      state.witchPotions.poison = false;
      didPoison = true;
      addLog(`Phù Thủy dùng Bình Độc lên ${describe(byId(poisonTargetId))}.`, { icon: '☠️', secret: true });
    }
    if (!didSave && !didPoison) addLog('Phù Thủy không dùng bình nào đêm nay.', { icon: '🧪', secret: true });

    if (didSave && didPoison) {
      window.AudioEngine.playWitchSave();
      setTimeout(() => window.AudioEngine.playWitchPoison(), 600);
    } else if (didSave) {
      window.AudioEngine.playWitchSave();
    } else if (didPoison) {
      window.AudioEngine.playWitchPoison();
    }

    closeNightStep('Phù Thủy đã hành động xong. Xin mời Phù Thủy nhắm mắt lại.');
  }

  function runSerialKillerStep() {
    const aliveSK = state.players.find((p) => p.alive && p.roleId === 'serial_killer');
    setBotSpeech('Sát Nhân Độc Hành ơi, hãy mở mắt dậy và chọn 1 mục tiêu để ám sát đêm nay.', () => {
      if (!aliveSK) {
        hostStepTimer = setTimeout(() => finishSerialKillerStep(null), 3500);
      } else if (aliveSK.isDemo) {
        const candidates = state.players.filter((p) => p.alive && p.id !== aliveSK.id);
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        hostStepTimer = setTimeout(() => finishSerialKillerStep(pick ? pick.id : null), 1600);
      }
    });
  }

  function finishSerialKillerStep(targetId) {
    if (stepResolved || !state || state.phase !== 'NIGHT' || state.nightStep !== 'serial_killer') return;
    stepResolved = true;
    clearHostTimers();
    state.nightActions.serialKillerTarget = targetId || null;
    const t = targetId ? byId(targetId) : null;
    addLog(t ? `Sát Nhân chọn ám sát ${describe(t)}.` : 'Sát Nhân không ám sát ai.', { icon: '🗡️', secret: true });
    closeNightStep('Sát Nhân đã chọn xong mục tiêu. Xin mời Sát Nhân nhắm mắt lại.');
  }

  function handleHostNightOrHunterAction(senderId, payload) {
    const player = byId(senderId);
    if (!player) return;

    if (state.phase === 'NIGHT') {
      if (state.flow.key !== 'night_step') return; // bước đã chốt / đang chuyển cảnh

      if (state.nightStep === 'cupid' && payload.step === 'cupid' && player.alive && player.roleId === 'cupid') {
        const list = Array.isArray(payload.targetIds) ? payload.targetIds : [];
        if (list.length !== 2 || list[0] === list[1]) return;
        finishCupidStep(list);
        return;
      }

      if (state.nightStep === 'guard' && payload.step === 'guard' && player.alive && player.roleId === 'guard') {
        const tId = payload.targetId || null;
        if (tId) {
          const guardTarget = state.players.find((p) => p.id === tId && p.alive);
          if (!guardTarget || tId === state.lastGuardedId) return;
        }
        finishGuardStep(tId);
        return;
      }

      if (state.nightStep === 'werewolf' && payload.step === 'werewolf' && player.alive && isWolfRole(player.roleId)) {
        const prey = state.players.find((p) => p.id === payload.targetId && p.alive && !isWolfRole(p.roleId));
        if (!prey) return;
        if (state.nightActions.wolfVotes[senderId] === prey.id) {
          sendWolfSync(player); // không đổi gì: chỉ đồng bộ lại cho phone này
          return;
        }
        state.nightActions.wolfVotes[senderId] = prey.id;
        evaluateWolfVotes(); // đổi pick -> tính lại thống nhất / khóa 3 giây, rồi gửi sync cho cả bầy
        return;
      }

      if (
        state.nightStep === 'alpha_wolf' &&
        payload.step === 'alpha_wolf' &&
        player.alive &&
        player.roleId === 'alpha_wolf'
      ) {
        finishAlphaWolfStep(Boolean(payload.convert));
        return;
      }

      if (state.nightStep === 'seer' && payload.step === 'seer' && player.alive && player.roleId === 'seer') {
        if (payload.action === 'inspect' && payload.targetId) {
          if (state.nightActions.seerInspected) return;
          if (!Array.isArray(state.seerHistory)) state.seerHistory = [];
          if (state.seerHistory.includes(payload.targetId)) return;
          const target = state.players.find((p) => p.id === payload.targetId && p.alive && p.id !== senderId);
          if (target) {
            state.nightActions.seerInspected = true;
            state.nightActions.seerResultAt = Date.now();
            state.nightActions.seerTarget = target.id;
            state.seerHistory.push(target.id);
            addLog(
              `Tiên Tri ${player.name} soi ${describe(target)}: ${isWolfRole(target.roleId) ? 'thuộc phe Ma Sói' : 'thuộc phe Dân Làng'}.`,
              { icon: '🔮', secret: true }
            );
            syncStateToClients();
            sendSeerResultTo(player);
            armSeerSafety();
          }
        } else if (payload.action === 'done') {
          finishSeerStep();
        }
        return;
      }

      if (state.nightStep === 'witch' && payload.step === 'witch' && player.alive && player.roleId === 'witch') {
        const wantSave = Boolean(payload.useSave);
        let poisonId = payload.poisonTargetId || null;
        if (poisonId) {
          const validPoison = state.players.find((p) => p.id === poisonId && p.alive && p.id !== senderId);
          if (!validPoison || (wantSave && poisonId === state.nightActions.wolfTarget)) {
            poisonId = null;
          }
        }
        finishWitchStep(wantSave, poisonId);
        return;
      }

      if (
        state.nightStep === 'serial_killer' &&
        payload.step === 'serial_killer' &&
        player.alive &&
        player.roleId === 'serial_killer'
      ) {
        const target = state.players.find((p) => p.id === payload.targetId && p.alive && p.id !== senderId);
        finishSerialKillerStep(target ? target.id : null);
        return;
      }
    }

    if (state.phase === 'HUNTER_REVENGE' && payload.step === 'hunter' && senderId === state.pendingHunterId) {
      let targetId = payload.targetId || null;
      if (targetId) {
        const validShot = state.players.find((p) => p.id === targetId && p.alive && p.id !== senderId);
        if (!validShot) return;
      }
      if (!state.flow || state.flow.key !== 'hunter_wait') {
        // Bot còn đang đọc thông báo: giữ phát bắn lại, áp dụng ngay khi tới hunter_wait.
        state.queuedHunterShot = { hunterId: senderId, targetId };
        persistHost();
        return;
      }
      resolveHunterShot(targetId);
    }
  }

  // ==================== DEATHS ====================
  // Gộp mọi cái chết: ghi state.deaths, kéo theo người yêu (trừ khi ctx.noChain) và trả về danh sách chết mới.
  // ctx.phase: 'night' | 'day'. Trả về { dead: [player], chain: [{ partner, diedFor }] }.
  function killPlayers(list, ctx = {}) {
    const phase = ctx.phase || 'night';
    const dead = [];
    const chain = [];
    const kill = (p, cause) => {
      p.alive = false;
      state.deaths[p.id] = { round: state.nightNumber, phase, cause };
      dead.push(p);
    };
    list.forEach(({ id, cause }) => {
      const p = byId(id);
      if (p && p.alive) kill(p, cause);
    });
    if (!ctx.noChain && Array.isArray(state.lovers) && state.lovers.length === 2) {
      const pA = byId(state.lovers[0]);
      const pB = byId(state.lovers[1]);
      if (pA && pB) {
        let pair = null;
        if (!pA.alive && pB.alive) pair = { partner: pB, diedFor: pA };
        else if (!pB.alive && pA.alive) pair = { partner: pA, diedFor: pB };
        if (pair) {
          kill(pair.partner, 'lover');
          chain.push(pair);
          addLog(`${pair.partner.name} chết theo người yêu ${pair.diedFor.name} vì tình!`, {
            icon: '💔',
            phase: phase === 'night' ? 'night' : 'day'
          });
        }
      }
    }
    return { dead, chain };
  }

  function chainText(chain) {
    return chain.length > 0
      ? ` ${chain.map((d) => `${d.partner.name} chết theo người yêu ${d.diedFor.name}!`).join(' ')}`
      : '';
  }

  function setupHunters(hunters, next) {
    state.hunterQueue = hunters.slice(1).map((h) => h.id);
    state.pendingHunterId = hunters[0].id;
    state.pendingHunterNext = next;
    state.phase = 'HUNTER_REVENGE';
  }

  const CAUSE_TEXT = {
    wolf: 'bị Sói cắn',
    poison: 'bị Phù Thủy đầu độc',
    serial_killer: 'bị Sát Nhân ám sát'
  };

  function resolveNightAndStartDay() {
    clearHostTimers();
    const { guardTarget, wolfTarget, alphaConvert, witchSave, witchPoisonTarget, serialKillerTarget } =
      state.nightActions;

    const kills = [];
    let elderSurvivedHint = false;

    if (alphaConvert && wolfTarget && wolfTarget !== guardTarget) {
      const converted = state.players.find((p) => p.id === wolfTarget && p.alive);
      if (converted) {
        const before = roleNameOf(converted);
        converted.roleId = 'werewolf';
        state.alphaWolfConvertUsed = true;
        addLog(`Sói Đầu Đàn nguyền hóa thành công ${converted.name} (${before}) thành Ma Sói!`, {
          icon: '🩸',
          secret: true
        });
        state.players.forEach((p) => {
          if (p.id === converted.id || isWolfRole(p.roleId)) {
            sendSecretToPlayer(p);
          }
        });
      }
    } else if (wolfTarget) {
      const victim = byId(wolfTarget);
      if (alphaConvert) {
        addLog(`Lời nguyền thất bại: ${victim ? victim.name : '?'} được Bảo Vệ che chở.`, { icon: '🩸', secret: true });
      }
      if (wolfTarget === guardTarget) {
        addLog(`${victim ? describe(victim) : '?'} bị Sói cắn nhưng được Bảo Vệ che chở nên sống sót.`, {
          icon: '🛡️',
          secret: true
        });
      } else if (witchSave) {
        addLog(`${victim ? describe(victim) : '?'} bị Sói cắn nhưng được Phù Thủy cứu sống.`, {
          icon: '💚',
          secret: true
        });
      } else if (victim && victim.alive && victim.roleId === 'elder' && (state.elderLivesMap[victim.id] || 0) > 1) {
        state.elderLivesMap[victim.id] = 1;
        elderSurvivedHint = true;
        addLog(`Già Làng ${victim.name} bị Sói cắn nhưng nhờ lớp giáp đầu tiên vẫn bình an!`, {
          icon: '🧓',
          secret: true
        });
      } else {
        kills.push({ id: wolfTarget, cause: 'wolf' });
      }
    }

    if (witchPoisonTarget) kills.push({ id: witchPoisonTarget, cause: 'poison' });
    if (serialKillerTarget) {
      if (serialKillerTarget !== guardTarget) {
        kills.push({ id: serialKillerTarget, cause: 'serial_killer' });
      } else {
        addLog(`Sát Nhân ám sát ${describe(byId(serialKillerTarget))} nhưng được Bảo Vệ che chở.`, {
          icon: '🛡️',
          secret: true
        });
      }
    }

    const { dead: deadPlayers, chain: loverDeaths } = killPlayers(kills, { phase: 'night' });
    deadPlayers.forEach((p) => {
      const cause = state.deaths[p.id].cause;
      if (CAUSE_TEXT[cause]) addLog(`${describe(p)} ${CAUSE_TEXT[cause]} và chết trong đêm.`, { icon: '💀', secret: true });
    });

    window.AudioEngine.playRoosterDawn();
    if (deadPlayers.length > 0) {
      window.SceneFX.flash('rgba(244, 63, 94, 0.2)');
      setTimeout(() => window.AudioEngine.playDeath(), 260);
    }

    const loverExtra = chainText(loverDeaths).trimEnd();
    let announcement = '';
    if (deadPlayers.length === 0) {
      announcement = `Trời sáng rồi, xin mời mọi người mở mắt ra! Đêm qua là một đêm bình yên, không có ai thiệt mạng.`;
      state.lastDawnSummary = elderSurvivedHint
        ? '☀️ Đêm qua bình yên (Có người vừa thoát chết trong gang tấc!).'
        : '☀️ Đêm qua bình yên — Không có ai thiệt mạng.';
      addLog('Đêm qua bình yên, không ai thiệt mạng.', { icon: '☀️', phase: 'day' });
    } else {
      const names = deadPlayers.map((p) => p.name).join(', ');
      announcement = `Trời sáng rồi, xin mời mọi người mở mắt ra! Đêm qua có ${deadPlayers.length} người đã thiệt mạng, đó là: ${names}!${loverExtra ? ` Trong đó ${loverExtra}` : ''}`;
      state.lastDawnSummary = `💀 Đêm qua có ${deadPlayers.length} người thiệt mạng: ${names}.${loverExtra ? ` ${loverExtra}` : ''}`;
      addLog(`Đêm qua ${deadPlayers.length} người thiệt mạng: ${names}.`, { icon: '💀', phase: 'day' });
    }

    // Đêm 1 có Thần Tình Yêu và đã ghép đôi: nhắc cả làng kiểm tra thẻ bài (ai cũng xem thẻ nên không lộ cặp đôi).
    if (state.nightNumber === 1 && (state.rolesConfig.cupid || 0) > 0 && (state.lovers || []).length === 2) {
      announcement +=
        ' Đêm qua Thần Tình Yêu đã se duyên cho một cặp đôi. Mọi người hãy giữ thẻ bài để kiểm tra xem mình có được se duyên không nhé!';
    }

    const hunters = deadPlayers.filter((p) => p.roleId === 'hunter');
    resetDayVoteState();
    state.stepWatch = null;
    voteAllAnnounced = false;
    if (hunters.length > 0) {
      setupHunters(hunters, 'DAY');
    } else {
      state.phase = 'DAY';
    }
    setFlow('dawn', { announcement });
    renderHost();
    setBotSpeech(announcement, afterDawnAnnouncement);
  }

  function afterDawnAnnouncement() {
    if (!state) return;
    if (state.phase === 'HUNTER_REVENGE' && state.pendingHunterId) {
      triggerHunterPrompt();
      return;
    }
    setFlow('day');
    if (!checkWinCondition()) evaluateDayVotes(); // mọi người có thể đã vote xong trong lúc Bot đọc thông báo
  }

  function triggerHunterPrompt() {
    const hunter = byId(state.pendingHunterId);
    if (!hunter) {
      afterHunterResolved(state.pendingHunterNext);
      return;
    }
    setFlow('hunter_wait');
    const queued = state.queuedHunterShot;
    state.queuedHunterShot = null;
    if (queued && queued.hunterId === hunter.id) {
      const ok = !queued.targetId || state.players.some((p) => p.id === queued.targetId && p.alive && p.id !== hunter.id);
      if (ok) {
        resolveHunterShot(queued.targetId || null);
        return;
      }
    }
    ensureWatch(`hunter${Object.keys(state.deaths || {}).length}`);
    armReminders();
    renderHost();
    setBotSpeech(
      `Khoan đã! ${hunter.name} là Thợ Săn. Xin mời ${hunter.name} hô bắn ở ngoài rồi bấm chọn tên người bị bắn ngay trên điện thoại của mình!`,
      () => {
        if (hunter.isDemo) {
          hostStepTimer = setTimeout(() => resolveHunterShot(null), 1800);
        }
      }
    );
  }

  function resolveHunterShot(targetId) {
    clearHostTimers();
    if (!state || state.phase !== 'HUNTER_REVENGE' || !state.flow || state.flow.key !== 'hunter_wait') return;
    const hunter = byId(state.pendingHunterId);
    const nextAfter = state.pendingHunterNext;
    const hunterName = hunter ? hunter.name : '';
    state.pendingHunterId = null;

    let text;
    const target = targetId ? state.players.find((p) => p.id === targetId && p.alive) : null;
    if (target) {
      window.AudioEngine.playHunterShot();
      addLog(`Thợ Săn ${hunterName} bắn hạ ${target.name}!`, { icon: '🏹' });
      const { dead, chain } = killPlayers([{ id: target.id, cause: 'hunter' }], { phase: 'day' });
      dead
        .filter((p) => p.roleId === 'hunter')
        .forEach((p) => {
          if (!state.hunterQueue.includes(p.id)) state.hunterQueue.push(p.id);
        });
      const cm = chainText(chain);
      text = `Đoàng! Thợ Săn ${hunterName} đã bắn hạ ${target.name} trước khi ngã xuống!${cm}`;
      state.lastDawnSummary += ` 🏹 Thợ Săn bắn hạ ${target.name}.${cm}`;
    } else {
      addLog(`Thợ Săn ${hunterName} quyết định không bắn ai.`, { icon: '🏹' });
      text = `Thợ Săn ${hunterName} quyết định không bắn ai.`;
    }
    setFlow('after_hunter', { next: nextAfter, text });
    renderHost();
    setBotSpeech(text, () => afterHunterResolved(nextAfter));
  }

  function afterHunterResolved(nextAfter) {
    if (!state) return;
    state.pendingHunterNext = nextAfter;
    if (Array.isArray(state.hunterQueue) && state.hunterQueue.length > 0) {
      state.pendingHunterId = state.hunterQueue.shift();
      triggerHunterPrompt();
      return;
    }
    state.pendingHunterNext = null;
    if (checkWinCondition()) return;
    if (nextAfter === 'NEXT_NIGHT') {
      beginNextNight();
    } else {
      state.phase = 'DAY';
      resetDayVoteState();
      voteAllAnnounced = false;
      setFlow('day');
      syncStateToClients();
      renderHost();
    }
  }

  function lynchPlayer(targetId) {
    if (!state || state.phase !== 'DAY' || !state.flow || state.flow.key !== 'day') return;
    const target = state.players.find((p) => p.id === targetId && p.alive);
    if (!target) return;
    clearHostTimers();

    window.AudioEngine.playVoteGavel();
    window.SceneFX.flash('rgba(244, 63, 94, 0.18)');
    const votesText = describeDayVotes();
    resetDayVoteState();
    // Nhật ký công khai KHÔNG ghi vai của người bị treo cổ (vai chỉ lộ sau khi ván kết thúc).
    addLog(`Cả làng biểu quyết treo cổ ${target.name}.${votesText ? ` Phiếu bầu: ${votesText}.` : ''}`, {
      icon: '⚖️'
    });
    addLog(`Người bị treo cổ: ${describe(target)}.`, { icon: '⚖️', secret: true });

    // Phe Thứ 3 (Thằng Ngố / Kẻ Chán Đời): bị treo cổ ban ngày -> thắng ngay lập tức (trước cả chết theo)!
    if (target.roleId === 'jester') {
      killPlayers([{ id: target.id, cause: 'lynch' }], { phase: 'day', noChain: true });
      window.AudioEngine.playVictory();
      finishGame(
        'jester',
        `Trời ơi! ${target.name} chính là Thằng Ngố (Kẻ Chán Đời)! Cả làng đã bị lừa treo cổ và Phe Thứ 3 giành chiến thắng độc lập!`,
        '🃏'
      );
      return;
    }

    const { dead, chain } = killPlayers([{ id: target.id, cause: 'lynch' }], { phase: 'day' });
    const cm = chainText(chain);
    const text = `Cả làng đã biểu quyết treo cổ ${target.name}!${cm}`;
    state.lastDawnSummary = `⚖️ Cả làng đã treo cổ ${target.name}.${cm}`;
    const hunters = dead.filter((p) => p.roleId === 'hunter');
    if (hunters.length > 0) setupHunters(hunters, 'NEXT_NIGHT');
    setFlow('after_lynch', { text });
    renderHost();
    setBotSpeech(text, afterLynchAnnouncement);
  }

  function afterLynchAnnouncement() {
    if (!state) return;
    if (state.phase === 'HUNTER_REVENGE' && state.pendingHunterId) {
      triggerHunterPrompt();
      return;
    }
    if (!checkWinCondition()) {
      setFlow('to_night');
      hostStepTimer = setTimeout(() => beginNextNight(), 1400);
    }
  }

  function skipLynchToNight() {
    if (!state || state.phase !== 'DAY' || !state.flow || state.flow.key !== 'day') return;
    clearHostTimers();
    window.AudioEngine.playVoteGavel();
    const votesText = describeDayVotes();
    resetDayVoteState();
    addLog(`Hòa phiếu / bỏ phiếu trắng, không ai bị treo cổ.${votesText ? ` Phiếu bầu: ${votesText}.` : ''}`, {
      icon: '🤝'
    });
    setFlow('to_night');
    setBotSpeech('Hôm nay không có ai bị treo cổ. Màn đêm lại chuẩn bị buông xuống...', () => {
      hostStepTimer = setTimeout(() => beginNextNight(), 1100);
    });
  }

  function finishGame(winner, winMsg, icon) {
    clearHostTimers();
    state.phase = 'GAME_OVER';
    state.winner = winner;
    state.pendingHunterId = null;
    state.hunterQueue = [];
    cancelVoteLock();
    state.queuedHunterShot = null;
    addLog(winMsg, { icon, phase: 'end' });
    saveLastGame();
    setFlow('game_over', { msg: winMsg });
    renderHost();
    setBotSpeech(winMsg);
  }

  function checkWinCondition() {
    const alive = state.players.filter((p) => p.alive);
    const aliveWolves = alive.filter((p) => isWolfRole(p.roleId)).length;
    const aliveSK = alive.filter((p) => p.roleId === 'serial_killer').length;
    const aliveNonWolves = alive.filter((p) => !isWolfRole(p.roleId)).length;

    let isCrossTeamLoversWin = false;
    if (Array.isArray(state.lovers) && state.lovers.length === 2 && alive.length === 2) {
      const [idA, idB] = state.lovers;
      const pA = alive.find((p) => p.id === idA);
      const pB = alive.find((p) => p.id === idB);
      if (pA && pB && getPlayerSide(pA.roleId) !== getPlayerSide(pB.roleId)) {
        isCrossTeamLoversWin = true;
      }
    }

    let winner = null;
    if (isCrossTeamLoversWin) {
      winner = 'lovers';
    } else if (aliveSK > 0 && (alive.length === 1 || (alive.length === 2 && aliveWolves === 0))) {
      winner = 'serial_killer';
    } else if (aliveWolves === 0 && aliveSK === 0) {
      winner = 'villager';
    } else if (aliveSK === 0 && aliveWolves >= aliveNonWolves) {
      winner = 'werewolf';
    }

    if (!winner) return false;

    window.AudioEngine.playVictory();
    const winMessages = {
      villager: 'Chúc mừng Phe Dân Làng đã chiến thắng! Toàn bộ Ma Sói và Sát Nhân đã bị tiêu diệt!',
      werewolf: 'Ma Sói đã chiếm quyền kiểm soát ngôi làng! Phe Ma Sói chiến thắng!',
      serial_killer: 'Sát Nhân Độc Hành là kẻ sống sót cuối cùng! Phe Thứ 3 Sát Nhân chiến thắng độc lập!',
      lovers: 'Cặp Đôi Tình Nhân đã sống sót đến giây phút cuối cùng! Tình yêu bất diệt chiến thắng!'
    };
    finishGame(winner, winMessages[winner] || 'Trò chơi kết thúc!', '🏆');
    return true;
  }

  // ==================== VIEW-MODELS (dùng chung host + phone) ====================
  const CAUSE_NOTE = {
    wolf: 'bị Sói cắn',
    poison: 'bị đầu độc',
    serial_killer: 'bị Sát Nhân ám sát',
    lynch: 'bị treo cổ',
    hunter: 'bị Thợ Săn bắn',
    lover: 'chết theo người yêu'
  };
  const WIN_TITLE = {
    villager: '🏆 PHE DÂN LÀNG CHIẾN THẮNG!',
    werewolf: '🐺 PHE MA SÓI CHIẾN THẮNG!',
    jester: '🃏 PHE THỨ 3 — THẰNG NGỐ (KẺ CHÁN ĐỜI) CHIẾN THẮNG!',
    serial_killer: '🗡️ PHE THỨ 3 — SÁT NHÂN ĐỘC HÀNH CHIẾN THẮNG!',
    lovers: '💘 PHE THỨ 3 — CẶP ĐÔI TÌNH NHÂN CHIẾN THẮNG!'
  };
  const WIN_SUB = {
    villager: 'Toàn bộ Ma Sói và Sát Nhân đã bị tiêu diệt.',
    werewolf: 'Ma Sói đã chiếm quyền kiểm soát ngôi làng.',
    jester: 'Cả làng đã bị lừa treo cổ Thằng Ngố.',
    serial_killer: 'Sát Nhân Độc Hành là kẻ sống sót cuối cùng.',
    lovers: 'Cặp đôi khác phe sống sót đến cuối cùng.'
  };

  function deathNoteOf(st, id, withCause) {
    const d = (st.deaths || {})[id];
    if (!d) return '';
    const when = `${d.phase === 'night' ? 'Đêm' : 'Ngày'} ${d.round}`;
    return withCause && d.cause && CAUSE_NOTE[d.cause] ? `${when} — ${CAUSE_NOTE[d.cause]}` : when;
  }

  function didWin(winner, p, lovers) {
    if (winner === 'villager') return getPlayerSide(p.roleId) === 'villager';
    if (winner === 'werewolf') return isWolfRole(p.roleId);
    if (winner === 'jester') return p.roleId === 'jester';
    if (winner === 'serial_killer') return p.roleId === 'serial_killer';
    if (winner === 'lovers') return lovers.includes(p.id);
    return false;
  }

  // st: state của host hoặc state công khai ở GAME_OVER (đều có roleId/startRoleId/deaths.cause/lovers).
  function buildGameOverVm(st, myId) {
    const lovers = st.lovers || [];
    return {
      winner: st.winner,
      winnerTitle: WIN_TITLE[st.winner] || '🏆 KẾT THÚC!',
      winnerSub: WIN_SUB[st.winner] || '',
      myId: myId || null,
      players: st.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatarId: p.avatarId,
        alive: p.alive,
        roleId: p.roleId || 'villager',
        startRoleId: p.startRoleId || p.roleId || 'villager',
        isLover: lovers.includes(p.id),
        deathNote: p.alive ? '' : deathNoteOf(st, p.id, true) || 'Đã chết',
        won: didWin(st.winner, { id: p.id, roleId: p.roleId || 'villager' }, lovers)
      }))
    };
  }

  function buildHostBoardVm() {
    const inDay = state.phase === 'DAY';
    const against = {};
    if (inDay) {
      Object.entries(state.dayVotes || {}).forEach(([vId, tId]) => {
        const v = byId(vId);
        if (v && v.alive) against[tId] = (against[tId] || 0) + 1;
      });
    }
    return {
      phase: state.phase,
      players: state.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatarId: p.avatarId,
        alive: p.alive,
        online: p.isDemo ? true : Boolean(session && session.isClientOnline && session.isClientOnline(p.id)),
        isDemo: Boolean(p.isDemo),
        ready: Boolean(p.ready),
        voted: inDay && Boolean(state.dayVotes && state.dayVotes[p.id]),
        votesAgainst: inDay ? against[p.id] || 0 : 0,
        deathNote: p.alive ? '' : deathNoteOf(state, p.id, false) || 'Đã chết'
      }))
    };
  }

  function getDayVoteTally() {
    const groups = {}; // targetId -> [{ id, name, avatarId }]
    Object.entries(state.dayVotes || {}).forEach(([vId, tId]) => {
      const voter = byId(vId);
      if (!voter || !voter.alive) return;
      if (!groups[tId]) groups[tId] = [];
      groups[tId].push({ id: voter.id, name: voter.name, avatarId: voter.avatarId });
    });

    const entries = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    const topVotes = entries[0] ? entries[0][1].length : 0;
    const isTie = entries.length > 1 && entries[1][1].length === topVotes;
    const leaderId = entries[0] ? entries[0][0] : null;
    return { groups, entries, topVotes, isTie, leaderId };
  }

  // ==================== RESUME (sau F5 / sập máy / mất mạng của host) ====================
  function resumeHostFlow() {
    if (!state || !isHost) return;
    const flow = state.flow || { key: 'lobby', data: {} };
    const data = flow.data || {};
    clearHostTimers();
    speechPrefix = RESUME_PREFIX;

    switch (flow.key) {
      case 'role_reveal':
        runRoleReveal();
        break;
      case 'night_intro':
        runNightIntro();
        break;
      case 'night_step':
        stepResolved = false;
        runNightStepPrompt(state.nightStep);
        break;
      case 'night_step_done':
        stepResolved = true;
        advanceNightStep();
        break;
      case 'dawn':
        setBotSpeech(data.announcement || state.botText, afterDawnAnnouncement);
        break;
      case 'hunter_wait':
        triggerHunterPrompt();
        break;
      case 'after_hunter':
        setBotSpeech(data.text || 'Thợ Săn đã hành động xong.', () => afterHunterResolved(data.next));
        break;
      case 'after_lynch':
        setBotSpeech(data.text || 'Cả làng đã biểu quyết xong.', afterLynchAnnouncement);
        break;
      case 'to_night':
        beginNextNight(); // lời "Đêm thứ N..." mang tiền tố kết nối lại
        break;
      case 'day':
        speechPrefix = '';
        setBotSpeech('Bot Quản Trò đã quay lại, ván đấu tiếp tục! Mời cả làng tiếp tục thảo luận và bỏ phiếu.');
        armVoteLockTimer(); // đếm ngược 8 giây (nếu đang chạy) được dựng lại từ endsAt đã lưu
        break;
      case 'game_over':
      case 'lobby':
      default:
        speechPrefix = '';
        break;
    }
  }

  // ==================== CLIENT MESSAGE HANDLER ====================
  function handleClientMessage(msg) {
    if (!state) return;
    const { type } = msg;
    const payload = msg.payload || {};

    if (type === 'WW_STATE') {
      if (payload.epoch && payload.epoch !== state.epoch) {
        // Phòng mới / host mới tạo ván mới: bỏ hết bí mật & trạng thái cục bộ cũ.
        const hadEpoch = Boolean(state.epoch);
        lastReceivedSeq = -1;
        resetClientLocalState();
        state = createInitialHostState();
        state.epoch = null;
        lastPlayerSceneKey = '';
        // Đã từng biết epoch khác -> JOIN lại để lấy bí mật của epoch mới.
        if (hadEpoch && payload.phase !== 'LOBBY') setTimeout(() => announceJoin(true), 0);
      } else if (
        typeof payload.stateSeq === 'number' &&
        payload.phase !== 'LOBBY' &&
        payload.stateSeq < lastReceivedSeq
      ) {
        return;
      }
      if (typeof payload.stateSeq === 'number') {
        lastReceivedSeq = payload.stateSeq;
      }

      const prevStep = state.nightStep;
      const prevPhase = state.phase;
      const prevPendingHunter = state.pendingHunterId;
      state = { ...state, ...payload };

      const meSynced = (state.players || []).find((p) => p.id === session.clientId);
      if (meSynced && meSynced.avatarId) {
        myAvatarId = meSynced.avatarId;
      }

      if (state.phase === 'LOBBY') {
        clientSecret = null;
        witchInfo = null;
        alphaInfo = null;
        seerResult = null;
        wolfSync = { wolfVotes: {}, wolfCount: 1, lock: null };
        selectedCupidTargets = [];
        selectedHunterTarget = null;
        cardRevealed = false;
        cardHasNews = false;
        newsNotifiedSig = '';
      }

      // Đếm ngược chốt phiếu: tính mốc kết thúc theo đồng hồ máy này.
      clientVoteLockEnd = state.voteLock ? Date.now() + (Number(state.voteLock.remainingMs) || 0) : 0;

      if (state.phase === 'NIGHT' && (prevPhase !== 'NIGHT' || prevStep !== state.nightStep)) {
        selectedNightTarget = null;
        selectedCupidTargets = [];
        witchSaveChoice = false;
        witchPoisonChoice = null;
        alphaInfo = null;
        seerResult = null;
        wolfSync = { wolfVotes: {}, wolfCount: 1, lock: null };

        const isMyTurn =
          clientSecret &&
          (state.nightStep === clientSecret.roleId ||
            (state.nightStep === 'werewolf' && isWolfRole(clientSecret.roleId)));
        if (isMyTurn && isMeAlive()) notifyMyTurn([120, 60, 120]);
      }

      if (state.phase === 'HUNTER_REVENGE' && state.pendingHunterId === session.clientId) {
        if (prevPhase !== 'HUNTER_REVENGE' || prevPendingHunter !== session.clientId) {
          selectedHunterTarget = null;
          notifyMyTurn([180, 80, 180]);
        }
      }

      updateCardNews();
      renderPlayer();
      return;
    }

    if (type === 'WW_SECRET') {
      clientSecret = payload;
      updateCardNews();
      renderPlayer();
      return;
    }

    if (type === 'WW_WITCH_INFO') {
      witchInfo = payload;
      renderPlayer();
      return;
    }

    if (type === 'WW_ALPHA_INFO') {
      alphaInfo = payload;
      renderPlayer();
      return;
    }

    if (type === 'WW_SEER_RESULT') {
      seerResult = payload;
      renderPlayer();
      return;
    }

    if (type === 'WW_WOLF_SYNC') {
      wolfSync = {
        wolfVotes: payload.wolfVotes || {},
        wolfCount: Math.max(1, Number(payload.wolfCount) || 1),
        lock: payload.lock && payload.lock.targetId ? { targetId: payload.lock.targetId, remainingMs: Number(payload.lock.remainingMs) || 0 } : null
      };
      wolfLockEndLocal = wolfSync.lock ? Date.now() + wolfSync.lock.remainingMs : 0;
      renderPlayer();
    }
  }

  // "Đến lượt bạn": rung (iOS không có) + chớp sáng + tiếng nhẹ.
  function notifyMyTurn(pattern) {
    vibrate(pattern);
    try {
      if (window.SceneFX && typeof window.SceneFX.flash === 'function') window.SceneFX.flash('rgba(251, 191, 36, 0.28)');
    } catch (_) {}
    try {
      if (window.AudioEngine && typeof window.AudioEngine.playUi === 'function') window.AudioEngine.playUi();
    } catch (_) {}
  }

  // ----- "Thẻ bài có tin mới" -----
  function secretSig() {
    if (!clientSecret || !clientSecret.roleId) return '';
    const mates = (clientSecret.teammates || []).map((m) => m.id).sort().join(',');
    return [clientSecret.roleId, (clientSecret.loverInfo && clientSecret.loverInfo.id) || '', mates, clientSecret.converted ? 1 : 0].join('|');
  }

  function seenKey() {
    return `${(state && state.epoch) || ''}:${(state && state.gameNo) || 0}`;
  }

  function readSeenCard() {
    try {
      return JSON.parse(lsGet('hq_ww_card_seen') || 'null');
    } catch (_) {
      return null;
    }
  }

  function updateCardNews() {
    const sig = secretSig();
    if (!sig || !state || !state.epoch || state.phase === 'LOBBY' || state.phase === 'GAME_OVER') {
      cardHasNews = false;
      return;
    }
    const seen = readSeenCard();
    const news = !(seen && seen.key === seenKey() && seen.sig === sig);
    if (news && newsNotifiedSig !== sig) {
      newsNotifiedSig = sig;
      vibrate([200, 100, 200]);
    }
    cardHasNews = news;
    if (news && cardRevealed && !peekTimer) peekTimer = setTimeout(markCardSeen, 700);
  }

  function markCardSeen() {
    peekTimer = null;
    const sig = secretSig();
    if (!sig) return;
    lsSet('hq_ww_card_seen', JSON.stringify({ key: seenKey(), sig }));
    cardHasNews = false;
    newsNotifiedSig = sig;
    renderSecretCard();
  }

  function isMeAlive() {
    if (!state || !session) return false;
    const me = state.players.find((p) => p.id === session.clientId);
    return me ? me.alive : false;
  }

  // ==================== HOST UI & EVENTS ====================
  function returnToLobby() {
    if (!state) return;
    clearHostTimers();
    speechPrefix = '';
    try {
      window.AudioEngine.stopSpeech();
      window.AudioEngine.stopNightAmbience();
    } catch (_) {}
    state.phase = 'LOBBY';
    state.nightNumber = 0;
    state.nightStep = null;
    state.nightActions = createNightActions();
    resetDayVoteState(); state.stepWatch = null; state.queuedHunterShot = null;
    state.winner = null;
    state.lovers = [];
    state.lastGuardedId = null;
    state.seerHistory = [];
    state.alphaWolfConvertUsed = false;
    state.elderLivesMap = {};
    state.witchPotions = { save: true, poison: true };
    state.pendingHunterId = null;
    state.pendingHunterNext = null;
    state.hunterQueue = [];
    state.lastDawnSummary = '';
    state.logs = [];
    state.logSeq = 0;
    state.deaths = {};
    state.botText = 'Chờ tất cả người chơi vào phòng và ấn Sẵn sàng...';
    stepResolved = false;
    voteAllAnnounced = false;
    lastHostSceneKey = '';
    state.players.forEach((p) => {
      p.alive = true;
      p.roleId = null;
      p.startRoleId = null;
      p.ready = Boolean(p.isDemo);
    });
    setFlow('lobby');
    syncStateToClients();
    renderHost();
  }

  function bindHostEvents() {
    const shareUrl = () => window.RoomNetwork.buildShareUrl();

    document.getElementById('ww-host-copy-link').onclick = () => {
      window.AppUI.copyText(shareUrl(), 'Đã copy link mở app Hội Quán!');
    };

    const openWwQrZoom = () => {
      window.AppUI.openQrZoomModal('🐺 Quét QR để mở app Hội Quán', window.RoomNetwork.ROOM_LABEL, shareUrl());
    };
    const wwQrEl = document.getElementById('ww-host-qr');
    const wwQrBtn = document.getElementById('ww-qr-zoom-btn');
    if (wwQrEl) wwQrEl.onclick = openWwQrZoom;
    if (wwQrBtn) wwQrBtn.onclick = openWwQrZoom;

    document.getElementById('ww-host-test-voice').onclick = () => {
      window.AudioEngine.unlock();
      window.AudioEngine.speak('Xin chào cả hội! Bot Quản Trò đã sẵn sàng dẫn dắt ván Ma Sói hôm nay.');
    };

    const replayBotVoice = () => {
      window.AudioEngine.unlock();
      if (state && state.botText) window.AudioEngine.speak(state.botText);
    };
    const hostReplayBtn = document.getElementById('ww-host-replay-voice');
    if (hostReplayBtn) hostReplayBtn.onclick = replayBotVoice;
    const ingameReplayBtn = document.getElementById('ww-replay-bot');
    if (ingameReplayBtn) ingameReplayBtn.onclick = replayBotVoice;

    const leaveHost = async () => {
      if (state && state.phase !== 'LOBBY') {
        const ok = await window.AppUI.confirmDialog(
          'Thoát phòng Ma Sói?',
          'Thoát sẽ KẾT THÚC ván Ma Sói đang chơi của cả hội. Chắc chắn chứ?'
        );
        if (!ok) return;
      }
      discardHostSnapshot();
      window.AppUI.clearSession?.();
      cleanup();
      window.AppUI.goHome();
    };

    document.getElementById('ww-host-leave').onclick = leaveHost;
    document.getElementById('ww-ingame-leave').onclick = leaveHost;
    document.getElementById('ww-ingame-sound').onclick = () => {
      window.AppUI.openSoundSettings();
    };

    document.getElementById('ww-host-add-demo').onclick = () => {
      if (!state || state.phase !== 'LOBBY') return;
      const demoNames = ['An', 'Bình', 'Chi', 'Dũng', 'Hà', 'Khánh', 'Linh', 'Minh', 'Ngọc', 'Phúc'];
      const name = `${demoNames[(demoCounter - 1) % demoNames.length]} (Test ${demoCounter})`;
      const avatarId = getRandomAvatarId(state.players.length);
      demoCounter += 1;
      state.players.push({
        id: `demo_${Date.now()}_${demoCounter}`,
        name,
        avatarId,
        ready: true,
        alive: true,
        isDemo: true,
        roleId: null
      });
      if (autoRolesMode && state.players.length >= 5) {
        state.rolesConfig = getRecommendedWerewolfRoles(state.players.length);
      }
      syncStateToClients();
      renderHost();
    };

    document.getElementById('ww-host-auto-roles').onclick = () => {
      autoRolesMode = true;
      state.rolesConfig = getRecommendedWerewolfRoles(Math.max(5, state.players.length));
      syncStateToClients();
      renderHost();
    };

    document.getElementById('ww-host-start-btn').onclick = () => startNewGame();

    document.getElementById('ww-host-skip-step').onclick = () => {
      if (!state || state.phase !== 'NIGHT' || state.flow.key !== 'night_step') return;
      if (state.nightStep === 'cupid') finishCupidStep([]);
      else if (state.nightStep === 'guard') finishGuardStep(null);
      else if (state.nightStep === 'werewolf') {
        const prey = state.players.find((p) => p.alive && !isWolfRole(p.roleId));
        finishWerewolfStep(pickMajorityWolfTarget(prey ? prey.id : null));
      } else if (state.nightStep === 'alpha_wolf') finishAlphaWolfStep(false);
      else if (state.nightStep === 'seer') finishSeerStep();
      else if (state.nightStep === 'witch') finishWitchStep(false, null);
      else if (state.nightStep === 'serial_killer') finishSerialKillerStep(null);
    };

    document.getElementById('ww-host-skip-hunter').onclick = () => resolveHunterShot(null);

    document.getElementById('ww-host-finalize-vote').onclick = async () => {
      if (!state || state.phase !== 'DAY') return;
      const tally = getDayVoteTally();
      if (!tally.leaderId) return;
      if (tally.isTie || tally.leaderId === '__skip__') {
        const ok = await window.AppUI.confirmDialog(
          'Hòa phiếu / Bỏ phiếu trắng?',
          'Kết quả hiện tại không có người bị treo cổ. Chuyển sang Đêm tiếp theo?'
        );
        if (ok) skipLynchToNight();
        return;
      }
      const leader = byId(tally.leaderId);
      if (!leader) return;
      const ok = await window.AppUI.confirmDialog(
        'Chốt treo cổ theo phiếu bầu?',
        `Treo cổ ${leader.name} (${tally.topVotes} phiếu)?`
      );
      if (ok) lynchPlayer(leader.id);
    };

    document.getElementById('ww-host-no-lynch').onclick = async () => {
      const ok = await window.AppUI.confirmDialog(
        'Xác nhận hòa phiếu?',
        'Không treo cổ ai hôm nay và chuyển sang đêm tiếp theo?'
      );
      if (ok) skipLynchToNight();
    };

    document.getElementById('ww-host-play-again').onclick = () => returnToLobby();

    const openLogBtn = document.getElementById('ww-host-open-log');
    if (openLogBtn) {
      openLogBtn.onclick = () => {
        if (!state) return;
        const over = state.phase === 'GAME_OVER';
        window.WWViews.openLogDialog({
          title: '📜 Nhật ký ván đấu',
          entries: state.logs,
          showSecret: over,
          note: over
            ? 'Ván đã kết thúc — mọi hành động bí mật được hiện ra.'
            : 'Màn hình này cả bàn đều nhìn thấy nên chỉ hiện sự kiện công khai. Hành động bí mật ban đêm sẽ hiện sau khi ván kết thúc.'
        });
      };
    }

    const lastGameBtn = document.getElementById('ww-host-last-game-btn');
    if (lastGameBtn) {
      lastGameBtn.onclick = () => {
        let last = null;
        try {
          last = JSON.parse(lsGet(LAST_GAME_KEY) || 'null');
        } catch (_) {}
        if (!last) return;
        const when = last.finishedAt ? new Date(last.finishedAt).toLocaleString('vi-VN') : '';
        const summary = (last.players || [])
          .map((p) => `${p.name}: ${(WEREWOLF_ROLES[p.roleId] || {}).name || '?'}`)
          .join(' • ');
        window.WWViews.openLogDialog({
          title: `📜 Ván trước${when ? ` — ${when}` : ''}`,
          entries: last.logs || [],
          showSecret: true,
          note: `${WIN_TITLE[last.winner] || 'Ván đã kết thúc'}  |  ${summary}`
        });
      };
    }

    const voteCancelBtn = document.getElementById('ww-host-vote-cancel');
    if (voteCancelBtn) {
      voteCancelBtn.onclick = () => {
        if (!state || state.phase !== 'DAY' || !state.voteLock) return;
        cancelVoteLock();
        state.voteLockPaused = true; // chạy lại khi có phiếu đổi
        addLog('Đã tạm dừng đếm ngược chốt phiếu.', { icon: '⏸' });
        syncStateToClients();
        renderHost();
      };
    }

    const resetBtn = document.getElementById('ww-host-reset-game');
    if (resetBtn) {
      resetBtn.onclick = async () => {
        const ok = await window.AppUI.confirmDialog(
          'Reset ván?',
          'Reset ván đang chơi và đưa cả hội về phòng chờ? Người chơi vẫn ở trong phòng.'
        );
        if (ok) returnToLobby();
      };
    }
  }

  function renderHostShareBox() {
    const codeEl = document.getElementById('ww-host-code');
    if (codeEl) codeEl.textContent = window.RoomNetwork.ROOM_LABEL;
    const shareUrl = window.RoomNetwork.buildShareUrl();
    const urlEl = document.getElementById('ww-host-share-url');
    if (urlEl) urlEl.textContent = shareUrl;
    window.AppUI.renderQrCode(document.getElementById('ww-host-qr'), shareUrl);
  }

  function buildPlayerLabelEl(player, sizeClass = 'avatar-md', suffix = '') {
    const wrap = document.createElement('span');
    wrap.className = 'player-name-with-avatar';
    wrap.appendChild(window.AppUI.createAvatarEl(player?.avatarId, sizeClass));
    const txt = document.createElement('strong');
    txt.textContent = `${player?.name || '?'}${suffix}`;
    wrap.appendChild(txt);
    return wrap;
  }

  function runHostScene() {
    if (!state) return;
    const key = `${state.phase}:${state.nightNumber}`;
    if (key === lastHostSceneKey) return;
    lastHostSceneKey = key;

    if (state.phase === 'ROLE_REVEAL') {
      window.AudioEngine.playStart();
      window.SceneFX.playPhase({
        mode: 'role',
        icon: '🃏',
        kicker: 'CHIA VAI BÍ MẬT',
        title: 'VAI TRÒ CỦA BẠN',
        sub: 'Nhấn & giữ thẻ trên điện thoại để xem — thả tay thẻ tự úp lại.',
        duration: 2300
      });
    } else if (state.phase === 'NIGHT') {
      window.AudioEngine.playNightAmbience();
      window.AudioEngine.startNightAmbience();
      window.SceneFX.playPhase({
        mode: 'night',
        icon: '🌙',
        kicker: `MÀN ĐÊM ${state.nightNumber}`,
        title: `ĐÊM ${state.nightNumber}`,
        sub: 'Trời tối rồi, xin mời cả làng nhắm mắt lại.',
        duration: 2200
      });
    } else if (state.phase === 'DAY') {
      window.AudioEngine.stopNightAmbience();
      window.SceneFX.playPhase({
        mode: 'day',
        icon: '☀️',
        kicker: `BÌNH MINH NGÀY ${state.nightNumber}`,
        title: 'TRỜI SÁNG',
        sub: state.lastDawnSummary || 'Cả làng mở mắt và bắt đầu tranh luận.',
        duration: 2400
      });
    } else if (state.phase === 'HUNTER_REVENGE') {
      window.AudioEngine.stopNightAmbience();
      window.SceneFX.flash('rgba(244, 63, 94, 0.3)');
      window.SceneFX.shake();
    } else if (state.phase === 'GAME_OVER') {
      window.AudioEngine.stopNightAmbience();
      window.SceneFX.celebrate();
      window.SceneFX.flash('rgba(251, 191, 36, 0.24)');
    }
  }

  function runPlayerScene() {
    if (!state || isHost) return;
    const key = `${state.phase}:${state.nightNumber}`;
    if (key === lastPlayerSceneKey) return;
    lastPlayerSceneKey = key;

    if (state.phase === 'ROLE_REVEAL') {
      window.SceneFX.playPhase({
        mode: 'role',
        icon: '🃏',
        kicker: 'THẺ BÀI CỦA BẠN',
        title: 'BÍ MẬT',
        sub: 'Nhấn & giữ thẻ phía dưới để xem vai trò.',
        duration: 2000
      });
    } else if (state.phase === 'NIGHT') {
      window.SceneFX.playPhase({
        mode: 'night',
        icon: '🌙',
        kicker: `MÀN ĐÊM ${state.nightNumber}`,
        title: `ĐÊM ${state.nightNumber}`,
        sub: 'Nhắm mắt lại và lắng nghe Bot Quản Trò.',
        duration: 1800
      });
    } else if (state.phase === 'DAY') {
      window.SceneFX.playPhase({
        mode: 'day',
        icon: '☀️',
        kicker: `BÌNH MINH NGÀY ${state.nightNumber}`,
        title: 'TRỜI SÁNG',
        sub: 'Mở mắt, tranh luận và bỏ phiếu treo cổ.',
        duration: 1900
      });
    } else if (state.phase === 'GAME_OVER') {
      window.SceneFX.celebrate({ count: 90 });
    }
  }

  function renderHost() {
    if (!state) return;
    runHostScene();
    const isActive = state.phase !== 'LOBBY';
    const phaseMode = state.phase === 'NIGHT' || state.phase === 'ROLE_REVEAL' ? 'NIGHT' : 'DAY';
    window.AppUI.setActiveGameMode(isActive, phaseMode);

    const lobbyEl = document.getElementById('ww-host-lobby');
    const gameEl = document.getElementById('ww-host-game');

    if (state.phase === 'LOBBY') {
      lobbyEl.hidden = false;
      gameEl.hidden = true;
      renderHostLobby();
    } else {
      lobbyEl.hidden = true;
      gameEl.hidden = false;
      renderHostActiveGame();
    }
  }

  function renderHostLobby() {
    const count = state.players.length;
    const readyCount = state.players.filter((p) => p.ready).length;
    document.getElementById('ww-host-player-count').textContent = String(count);
    document.getElementById('ww-host-ready-summary').textContent = `${readyCount}/${count} sẵn sàng`;

    const listEl = document.getElementById('ww-host-player-list');
    listEl.innerHTML = '';
    if (count === 0) {
      const empty = document.createElement('li');
      empty.className = 'player-item';
      empty.textContent = 'Chưa có ai vào phòng. Hãy quét QR hoặc nhập mã phòng trên điện thoại.';
      listEl.appendChild(empty);
    } else {
      state.players.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'player-item pop-in';
        const left = buildPlayerLabelEl(p, 'avatar-md');

        const right = document.createElement('div');
        right.style.display = 'flex';
        right.style.gap = '0.45rem';
        right.style.alignItems = 'center';

        const badge = document.createElement('span');
        badge.className = `pill ${p.ready ? 'pill-ready' : 'pill-wait'}`;
        badge.textContent = p.ready ? 'Sẵn sàng' : 'Đang chờ';

        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'btn btn-ghost btn-sm';
        kickBtn.textContent = '✕';
        kickBtn.setAttribute('aria-label', `Xóa ${p.name}`);
        kickBtn.addEventListener('click', () => {
          state.players = state.players.filter((x) => x.id !== p.id);
          if (autoRolesMode && state.players.length >= 5) {
            state.rolesConfig = getRecommendedWerewolfRoles(state.players.length);
          }
          syncStateToClients();
          renderHost();
        });

        if (!p.isDemo && session && !session.isClientOnline(p.id)) {
          li.classList.add('is-offline');
          const off = document.createElement('span');
          off.className = 'pill pill-wait';
          off.textContent = '🔴 Mất kết nối';
          right.appendChild(off);
        }

        right.append(badge, kickBtn);
        li.append(left, right);
        listEl.appendChild(li);
      });
    }

    const configEl = document.getElementById('ww-host-role-config');
    configEl.innerHTML = '';
    const order = [
      'werewolf',
      'alpha_wolf',
      'seer',
      'guard',
      'witch',
      'hunter',
      'cupid',
      'elder',
      'jester',
      'serial_killer',
      'villager'
    ];
    let totalRoles = 0;

    order.forEach((roleId) => {
      const role = WEREWOLF_ROLES[roleId];
      const val = state.rolesConfig[roleId] || 0;
      totalRoles += val;

      const row = document.createElement('div');
      row.className = 'role-config-row';

      const info = document.createElement('div');
      info.className = 'role-config-info';
      const icon = document.createElement('span');
      icon.textContent = role.icon;
      icon.setAttribute('aria-hidden', 'true');
      const txt = document.createElement('div');
      txt.innerHTML = `<strong>${escapeHtml(role.name)}</strong><small>${escapeHtml(role.teamName)}</small>`;
      info.append(icon, txt);

      const stepper = document.createElement('div');
      stepper.className = 'stepper';
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.textContent = '−';
      minus.setAttribute('aria-label', `Giảm ${role.name}`);
      minus.addEventListener('click', () => {
        autoRolesMode = false;
        state.rolesConfig[roleId] = Math.max(0, (state.rolesConfig[roleId] || 0) - 1);
        syncStateToClients();
        renderHost();
      });

      const num = document.createElement('span');
      num.textContent = String(val);

      const plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '+';
      plus.setAttribute('aria-label', `Tăng ${role.name}`);
      plus.addEventListener('click', () => {
        autoRolesMode = false;
        const max = roleId === 'werewolf' || roleId === 'villager' ? 10 : 1;
        state.rolesConfig[roleId] = Math.min(max, (state.rolesConfig[roleId] || 0) + 1);
        syncStateToClients();
        renderHost();
      });

      stepper.append(minus, num, plus);
      row.append(info, stepper);
      configEl.appendChild(row);
    });

    const totalNote = document.getElementById('ww-host-role-total');
    const wolves = (state.rolesConfig.werewolf || 0) + (state.rolesConfig.alpha_wolf || 0);
    const villagersSide = totalRoles - wolves;
    const canStart =
      count >= 5 && readyCount === count && totalRoles === count && wolves >= 1 && villagersSide > wolves;

    if (count < 5) {
      totalNote.textContent = `Tổng vai trò: ${totalRoles} (Cần tối thiểu 5 người chơi)`;
    } else if (totalRoles !== count) {
      totalNote.textContent = `⚠️ Tổng vai trò (${totalRoles}) chưa khớp số người chơi (${count})!`;
    } else if (wolves < 1 || villagersSide <= wolves) {
      totalNote.textContent = `⚠️ Cần ít nhất 1 Ma Sói và phe Dân nhiều hơn Ma Sói!`;
    } else if (readyCount < count) {
      totalNote.textContent = `✅ Đã khớp ${totalRoles} vai trò — Đang chờ ${count - readyCount} người ấn Sẵn sàng.`;
    } else {
      totalNote.textContent = `🎉 Đủ ${count} người sẵn sàng — Có thể bắt đầu ngay!`;
    }

    document.getElementById('ww-host-start-btn').disabled = !canStart;

    const lastBtn = document.getElementById('ww-host-last-game-btn');
    if (lastBtn) lastBtn.hidden = !lsGet(LAST_GAME_KEY);
  }

  // ----- Đếm ngược chốt phiếu hiển thị trên laptop -----
  function hostCountdownText() {
    const lock = state.voteLock;
    const left = Math.max(0, Math.ceil((lock.endsAt - Date.now()) / 1000));
    if (lock.kind === 'lynch') {
      const t = byId(lock.targetId);
      return `⏳ Chốt treo cổ ${t ? t.name : ''} sau ${left} giây…`;
    }
    return `⏳ Không ai bị treo cổ — sang đêm sau ${left} giây…`;
  }

  function syncHostCountdown() {
    const el = document.getElementById('ww-host-vote-countdown');
    const cancel = document.getElementById('ww-host-vote-cancel');
    if (!el) return;
    const active = Boolean(state && state.phase === 'DAY' && state.voteLock);
    if (active) {
      el.hidden = false;
      el.textContent = hostCountdownText();
      if (cancel) cancel.hidden = false;
      if (!hostTickTimer) {
        const tick = () => {
          hostTickTimer = null;
          if (!state || !isHost || !state.voteLock || state.phase !== 'DAY') return;
          el.textContent = hostCountdownText();
          hostTickTimer = setTimeout(tick, 250);
        };
        hostTickTimer = setTimeout(tick, 250);
      }
    } else {
      if (hostTickTimer) {
        clearTimeout(hostTickTimer);
        hostTickTimer = null;
      }
      const paused = Boolean(state && state.phase === 'DAY' && state.voteLockPaused);
      el.hidden = !paused;
      if (paused) el.textContent = '⏸ Đã tạm dừng đếm ngược — có người đổi phiếu thì chạy lại, hoặc ấn Chốt bên dưới.';
      if (cancel) cancel.hidden = true;
    }
  }

  function renderHostActiveGame() {
    const aliveCount = state.players.filter((p) => p.alive).length;
    const phaseMap = {
      ROLE_REVEAL: 'CHIA VAI TRÒ',
      NIGHT: `ĐÊM ${state.nightNumber}`,
      HUNTER_REVENGE: 'THỢ SĂN RA TAY',
      DAY: `NGÀY ${state.nightNumber}`,
      GAME_OVER: 'KẾT THÚC'
    };
    document.getElementById('ww-host-phase-badge').textContent = phaseMap[state.phase] || state.phase;
    document.getElementById('ww-host-alive-count').textContent = `Còn sống: ${aliveCount}/${state.players.length}`;
    document.getElementById('ww-host-bot-text').textContent = state.botText;
    // Cuối ván: bảng lật vai chiếm trọn chiều ngang, ẩn "Bàn chơi" (đã có đủ trong bảng lật vai).
    const isOver = state.phase === 'GAME_OVER';
    const boardEl = document.getElementById('ww-host-board');
    const gameEl = document.getElementById('ww-host-game');
    if (gameEl) gameEl.classList.toggle('is-gameover', isOver);
    if (boardEl) {
      boardEl.hidden = isOver;
      if (!isOver) window.WWViews.hostBoard(boardEl, buildHostBoardVm());
    }
    syncHostCountdown();

    const nightBox = document.getElementById('ww-host-night-box');
    const dayBox = document.getElementById('ww-host-day-box');
    const overBox = document.getElementById('ww-host-gameover-box');
    const hunterWait = document.getElementById('ww-host-hunter-wait');

    nightBox.hidden = !(state.phase === 'NIGHT' || state.phase === 'ROLE_REVEAL');
    dayBox.hidden = !(state.phase === 'DAY' || state.phase === 'HUNTER_REVENGE');
    overBox.hidden = state.phase !== 'GAME_OVER';
    hunterWait.hidden = state.phase !== 'HUNTER_REVENGE';

    if (state.phase === 'NIGHT' || state.phase === 'ROLE_REVEAL') {
      const stepsEl = document.getElementById('ww-host-night-steps');
      stepsEl.innerHTML = '';
      const order = getActiveNightOrder();
      const labels = {
        cupid: '💘 Thần Tình Yêu ghép đôi 2 người (Đêm 1)',
        guard: '🛡️ Bảo Vệ thức dậy bảo vệ 1 người',
        werewolf: '🐺 Ma Sói thức dậy chọn con mồi',
        alpha_wolf: '🩸 Sói Đầu Đàn quyết định Nguyền hóa nạn nhân',
        seer: '🔮 Tiên Tri thức dậy soi thân phận',
        witch: '🧪 Phù Thủy thức dậy dùng bình thuốc',
        serial_killer: '🗡️ Sát Nhân thức dậy chọn mục tiêu ám sát'
      };
      const curIdx = state.nightStep ? order.indexOf(state.nightStep) : -1;
      order.forEach((stepKey, idx) => {
        const li = document.createElement('li');
        li.className = 'night-step-item';
        if (state.phase === 'NIGHT') {
          if (idx < curIdx) li.classList.add('done');
          else if (idx === curIdx) li.classList.add('active');
        }
        li.innerHTML = `<span>${labels[stepKey]}</span><span>${
          state.phase === 'NIGHT' && idx === curIdx ? 'Đang chờ...' : idx < curIdx ? 'Xong' : ''
        }</span>`;
        stepsEl.appendChild(li);
      });
    }

    if (state.phase === 'DAY' || state.phase === 'HUNTER_REVENGE') {
      document.getElementById('ww-host-night-result-banner').textContent = state.lastDawnSummary;

      // Render Live Phone Vote Tally
      const tally = getDayVoteTally();
      const votedTotal = Object.keys(state.dayVotes || {}).length;
      document.getElementById('ww-host-vote-progress').textContent = `${votedTotal}/${aliveCount} đã vote`;
      const maxTallyVotes = Math.max(1, tally.topVotes || 1);

      const tallyEl = document.getElementById('ww-host-vote-tally');
      tallyEl.innerHTML = '';
      if (tally.entries.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'vote-tally-item';
        empty.textContent = 'Chưa có ai bấm Vote trên điện thoại (có thể bấm Vote trực tiếp hoặc vote miệng ở ngoài).';
        tallyEl.appendChild(empty);
      } else {
        tally.entries.forEach(([tId, voters]) => {
          const li = document.createElement('li');
          li.className = 'vote-tally-item pop-in';

          const leftCol = document.createElement('div');
          if (tId === '__skip__') {
            const skipLabel = document.createElement('strong');
            skipLabel.textContent = '🏳️ Bỏ phiếu trắng';
            leftCol.appendChild(skipLabel);
          } else {
            const targetPlayer = state.players.find((p) => p.id === tId);
            leftCol.appendChild(buildPlayerLabelEl(targetPlayer, 'avatar-md'));
          }

          const voterWrap = document.createElement('div');
          voterWrap.className = 'voter-avatars-mini';
          voters.forEach((v) => {
            const pill = document.createElement('span');
            pill.className = 'voter-pill-mini';
            pill.appendChild(window.AppUI.createAvatarEl(v.avatarId, 'avatar-sm'));
            const vName = document.createElement('span');
            vName.textContent = v.name;
            pill.appendChild(vName);
            voterWrap.appendChild(pill);
          });
          leftCol.appendChild(voterWrap);

          const bar = document.createElement('div');
          bar.className = `vote-bar ${tId === tally.leaderId && !tally.isTie ? 'is-leading' : ''}`;
          const barFill = document.createElement('span');
          barFill.style.width = `${Math.max(7, Math.round((voters.length / maxTallyVotes) * 100))}%`;
          bar.appendChild(barFill);
          leftCol.appendChild(bar);

          const countPill = document.createElement('span');
          countPill.className = 'pill pill-ready';
          countPill.textContent = `${voters.length} phiếu`;

          li.append(leftCol, countPill);
          tallyEl.appendChild(li);
        });
      }

      const finalizeBtn = document.getElementById('ww-host-finalize-vote');
      finalizeBtn.hidden = !(state.phase === 'DAY' && tally.entries.length > 0);
      if (!finalizeBtn.hidden) {
        if (tally.isTie || tally.leaderId === '__skip__') {
          finalizeBtn.textContent = '🤝 Chốt theo phiếu: Hòa / Không treo cổ ai';
        } else {
          const leader = state.players.find((p) => p.id === tally.leaderId);
          finalizeBtn.textContent = `⚖️ Chốt treo cổ ${leader ? leader.name : ''} (${tally.topVotes} phiếu)`;
        }
      }

      // Direct manual lynch buttons
      const lynchGrid = document.getElementById('ww-host-lynch-grid');
      lynchGrid.innerHTML = '';
      const canLynch = state.phase === 'DAY';
      state.players
        .filter((p) => p.alive)
        .forEach((p) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'lynch-btn target-btn-avatar';
          btn.disabled = !canLynch;
          btn.appendChild(window.AppUI.createAvatarEl(p.avatarId, 'avatar-md'));
          const span = document.createElement('span');
          span.textContent = `Treo cổ ${p.name}`;
          btn.appendChild(span);
          btn.addEventListener('click', async () => {
            const ok = await window.AppUI.confirmDialog(
              'Xác nhận treo cổ?',
              `Xác nhận cả làng đã vote treo cổ ${p.name}?`
            );
            if (ok) lynchPlayer(p.id);
          });
          lynchGrid.appendChild(btn);
        });
      document.getElementById('ww-host-no-lynch').disabled = !canLynch;
    }

    if (state.phase === 'GAME_OVER') {
      const banner = document.getElementById('ww-host-winner-banner');
      if (banner) {
        banner.textContent = WIN_TITLE[state.winner] || '🏆 KẾT THÚC!';
        banner.hidden = true; // tiêu đề thắng-thua nằm trong gameOverBoard
      }
      const revealEl = document.getElementById('ww-host-reveal-list');
      if (revealEl) {
        revealEl.innerHTML = '';
        revealEl.hidden = true;
      }
      const revealHead = document.getElementById('ww-host-reveal-heading');
      if (revealHead) revealHead.hidden = true;
      const logHead = document.getElementById('ww-host-gameover-log-heading');
      if (logHead) logHead.hidden = false;
      window.WWViews.gameOverBoard(document.getElementById('ww-host-gameover-board'), buildGameOverVm(state, null));
      window.WWViews.timeline(document.getElementById('ww-host-gameover-log'), state.logs, { showSecret: true });
    }
  }

  // ==================== PLAYER UI & EVENTS ====================
  function bindPlayerEvents() {
    const leavePlayer = async () => {
      if (state && state.phase !== 'LOBBY') {
        const ok = await window.AppUI.confirmDialog(
          'Rời phòng Ma Sói?',
          'Bạn sẽ rời phòng. Mở lại app vẫn vào tiếp được ván đang chơi.'
        );
        if (!ok) return;
      }
      if (session) session.send('WW_LEAVE', {});
      window.AppUI.clearSession?.();
      cleanup();
      window.AppUI.goHome();
    };

    document.getElementById('ww-pl-leave').onclick = leavePlayer;
    document.getElementById('ww-pl-ingame-leave').onclick = leavePlayer;

    document.getElementById('ww-pl-edit-name').onclick = async () => {
      const profile = await window.AppUI.promptProfileDialog(myName, myAvatarId);
      if (profile && (profile.name !== myName || profile.avatarId !== myAvatarId)) {
        myName = profile.name;
        myAvatarId = profile.avatarId;
        lsSet('hq_player_name', myName);
        window.AppUI.saveAvatarId(myAvatarId);
        if (session) session.send('WW_RENAME', { name: myName, avatarId: myAvatarId });
        renderPlayer();
      }
    };

    document.getElementById('ww-pl-ready-btn').onclick = () => {
      window.AudioEngine.unlock();
      const me = state.players.find((p) => p.id === session.clientId);
      const nextReady = me ? !me.ready : true;
      session.send('WW_READY', { ready: nextReady });
    };

    window.AppUI.bindHoldToPeekCard(document.getElementById('ww-pl-toggle-card'), (show) => {
      if (cardRevealed === show) return;
      cardRevealed = show;
      if (peekTimer) {
        clearTimeout(peekTimer);
        peekTimer = null;
      }
      if (show) {
        window.AudioEngine.unlock();
        window.AudioEngine.playCardFlip();
        window.SceneFX.sparkleAtElement(document.getElementById('ww-pl-toggle-card'));
        setTimeout(() => window.AudioEngine.playRoleReveal(), 150);
        // Giữ thẻ ≥ 700 ms mới tính là đã xem tin mới.
        if (cardHasNews) peekTimer = setTimeout(markCardSeen, 700);
      }
      renderSecretCard();
    });

    const plLogBtn = document.getElementById('ww-pl-open-log');
    if (plLogBtn) {
      plLogBtn.onclick = () => {
        if (!state) return;
        const over = state.phase === 'GAME_OVER';
        window.WWViews.openLogDialog({
          title: '📜 Nhật ký ván đấu',
          entries: state.logs || [],
          showSecret: over,
          note: over ? '' : 'Hành động bí mật ban đêm sẽ hiện ra sau khi ván kết thúc.'
        });
      };
    }
  }

  let lastHasAction = false;

  function aliveOfPublic(id, fallback) {
    const p = state && state.players ? state.players.find((x) => x.id === id) : null;
    return p ? p.alive : fallback !== false;
  }

  function renderSecretCard() {
    const btn = document.getElementById('ww-pl-toggle-card');
    const bgLayer = document.getElementById('ww-pl-card-bg');
    btn.setAttribute('aria-expanded', String(cardRevealed));
    btn.classList.toggle('is-flipped', cardRevealed);
    btn.classList.toggle('has-news', cardHasNews);
    const newsPill = document.getElementById('ww-pl-card-news');
    if (newsPill) newsPill.hidden = !cardHasNews;

    const cardAv = document.getElementById('ww-pl-card-avatar');
    if (cardAv) {
      cardAv.innerHTML = '';
      cardAv.appendChild(window.AppUI.createAvatarEl(myAvatarId, 'avatar-xl'));
    }
    const cardOwner = document.getElementById('ww-pl-card-owner');
    if (cardOwner) {
      cardOwner.textContent = lastHasAction ? '👆 Giữ để xem vai trò' : `${myName || 'Bạn'} — 👆 Nhấn & GIỮ để xem Vai Trò`;
    }

    if (clientSecret && clientSecret.roleId) {
      const role = WEREWOLF_ROLES[clientSecret.roleId];
      if (bgLayer && role.bgImage) {
        bgLayer.style.backgroundImage = `url('${role.bgImage}')`;
      }
      if (role.themeColor) {
        btn.style.setProperty('--role-theme', role.themeColor);
      }
      document.getElementById('ww-pl-role-icon').textContent = role.icon;
      document.getElementById('ww-pl-role-name').textContent = role.name;
      const teamBadge = document.getElementById('ww-pl-role-team');
      if (teamBadge) {
        teamBadge.hidden = false;
        teamBadge.textContent = role.teamName;
        teamBadge.dataset.team = role.team;
      }
      document.getElementById('ww-pl-role-desc').textContent = role.desc;

      // Đồng bọn / người yêu / bị nguyền: hiển thị lớn, rõ ràng (không còn dòng chữ nhỏ).
      const matesEl = document.getElementById('ww-pl-role-teammates');
      if (matesEl) matesEl.hidden = true;
      const li = clientSecret.loverInfo;
      window.WWViews.secretExtras(document.getElementById('ww-pl-secret-extras'), {
        teammates: (clientSecret.teammates || []).map((m) => ({ ...m, alive: aliveOfPublic(m.id, m.alive) })),
        lover: li ? { ...li, alive: aliveOfPublic(li.id, li.alive) } : null,
        converted: Boolean(clientSecret.converted)
      });
    }
  }

  // Người chơi có việc phải làm bây giờ? (-> thẻ bài thu gọn, vùng hành động hiện đủ)
  function playerHasAction(alive) {
    if (!state || !session || !alive) return false;
    const myId = session.clientId;
    if (!state.players.some((p) => p.id === myId)) return false;
    if (state.phase === 'DAY') return true;
    if (state.phase === 'HUNTER_REVENGE') return state.pendingHunterId === myId;
    if (state.phase === 'NIGHT') {
      const role = clientSecret && clientSecret.roleId;
      return Boolean(role && (state.nightStep === role || (state.nightStep === 'werewolf' && isWolfRole(role))));
    }
    return false;
  }

  function renderPlayer() {
    if (!state || !session) return;
    runPlayerScene();
    const isActive = state.phase !== 'LOBBY';
    const phaseMode = state.phase === 'NIGHT' || state.phase === 'ROLE_REVEAL' ? 'NIGHT' : 'DAY';
    window.AppUI.setActiveGameMode(isActive, phaseMode);

    const plCodeEl = document.getElementById('ww-pl-room-code');
    if (plCodeEl) plCodeEl.textContent = window.RoomNetwork.ROOM_LABEL;
    const playerBotText = document.getElementById('ww-pl-bot-text');
    if (playerBotText) playerBotText.textContent = state.botText || 'Bot Quản Trò đang chuẩn bị...';
    document.getElementById('ww-pl-my-name').textContent = myName;
    const myAvSlot = document.getElementById('ww-pl-my-avatar');
    if (myAvSlot) {
      myAvSlot.innerHTML = '';
      myAvSlot.appendChild(window.AppUI.createAvatarEl(myAvatarId, 'avatar-md'));
    }

    const lobbyEl = document.getElementById('ww-pl-lobby');
    const gameEl = document.getElementById('ww-pl-game');

    if (state.phase === 'LOBBY') {
      lobbyEl.hidden = false;
      gameEl.hidden = true;

      const me = state.players.find((p) => p.id === session.clientId);
      const readyBtn = document.getElementById('ww-pl-ready-btn');
      if (me && me.ready) {
        readyBtn.textContent = '⏳ Đã Sẵn Sàng (Ấn để hủy)';
        readyBtn.className = 'btn btn-secondary btn-lg btn-block';
      } else {
        readyBtn.textContent = '✅ Ấn Sẵn Sàng';
        readyBtn.className = 'btn btn-success btn-lg btn-block';
      }

      document.getElementById('ww-pl-count').textContent = String(state.players.length);
      const list = document.getElementById('ww-pl-lobby-list');
      list.innerHTML = '';
      state.players.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'player-item pop-in';
        const left = buildPlayerLabelEl(p, 'avatar-sm', p.id === session.clientId ? ' (Bạn)' : '');
        const pill = document.createElement('span');
        pill.className = `pill ${p.ready ? 'pill-ready' : 'pill-wait'}`;
        pill.textContent = p.ready ? 'Sẵn sàng' : 'Đang chờ';
        li.append(left, pill);
        if (p.online === false && !p.isDemo) {
          li.classList.add('is-offline');
          const off = document.createElement('span');
          off.className = 'pill pill-wait';
          off.textContent = '🔴 Mất kết nối';
          li.appendChild(off);
        }
        list.appendChild(li);
      });
      return;
    }

    lobbyEl.hidden = true;
    gameEl.hidden = false;
    const activeChip = document.getElementById('ww-pl-active-player');
    if (activeChip) {
      activeChip.innerHTML = '';
      activeChip.appendChild(window.AppUI.createAvatarEl(myAvatarId, 'avatar-sm'));
      const chipName = document.createElement('span');
      chipName.textContent = myName;
      activeChip.appendChild(chipName);
    }

    const me = state.players.find((p) => p.id === session.clientId);
    const alive = me ? me.alive : false;
    lastHasAction = playerHasAction(alive);
    renderSecretCard();

    const aliveBadge = document.getElementById('ww-pl-alive-badge');
    aliveBadge.textContent = alive ? '❤️ Còn sống' : '💀 Đã bị loại';
    aliveBadge.className = `alive-status-pill ${alive ? '' : 'dead'}`;
    const mobileWrap = document.getElementById('ww-pl-game');
    if (mobileWrap) {
      mobileWrap.classList.toggle('is-dead', !alive);
      mobileWrap.classList.toggle('has-action', lastHasAction);
      // Cuối ván: ẩn hẳn thẻ bài "nhấn giữ để xem" — chỉ hiện bảng kết quả cho dễ xem.
      mobileWrap.classList.toggle('is-gameover', state.phase === 'GAME_OVER');
    }

    const phaseMap = {
      ROLE_REVEAL: 'XEM VAI TRÒ',
      NIGHT: `🌙 ĐÊM ${state.nightNumber}`,
      HUNTER_REVENGE: '🏹 THỢ SĂN RA TAY',
      DAY: `☀️ NGÀY ${state.nightNumber}`,
      GAME_OVER: '🏆 KẾT THÚC'
    };
    document.getElementById('ww-pl-phase-badge').textContent = phaseMap[state.phase] || state.phase;

    renderPlayerActionArea(alive);
  }

  function makeTargetBtn(player, labelText, isSelected, isDisabled, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `target-btn target-btn-avatar ${isSelected ? 'selected' : ''}`;
    btn.disabled = Boolean(isDisabled);
    btn.appendChild(window.AppUI.createAvatarEl(player.avatarId, 'avatar-md'));
    const span = document.createElement('span');
    span.textContent = labelText;
    btn.appendChild(span);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function sendAction(payload) {
    if (session) session.send('WW_ACTION', payload);
  }

  function openPlayerLog() {
    if (!state) return;
    const over = state.phase === 'GAME_OVER';
    window.WWViews.openLogDialog({
      title: '📜 Nhật ký ván đấu',
      entries: state.logs || [],
      showSecret: over,
      note: over ? '' : 'Hành động bí mật ban đêm sẽ hiện ra sau khi ván kết thúc.'
    });
  }

  function voteCountdownText() {
    const lock = state && state.voteLock;
    if (!lock) return '';
    const left = Math.max(0, Math.ceil((clientVoteLockEnd - Date.now()) / 1000));
    if (lock.kind === 'lynch') {
      const t = state.players.find((p) => p.id === lock.targetId);
      return `⏳ Chốt treo cổ ${t ? t.name : ''} sau ${left} giây — muốn đổi phiếu thì đổi ngay!`;
    }
    return `⏳ Không ai bị treo cổ — sang đêm sau ${left} giây — muốn đổi phiếu thì đổi ngay!`;
  }

  function ensurePlayerTick() {
    if (playerTickTimer) return;
    const tick = () => {
      playerTickTimer = null;
      const el = document.getElementById('ww-pl-vote-countdown');
      if (!state || !state.voteLock || !el) return;
      el.textContent = voteCountdownText();
      playerTickTimer = setTimeout(tick, 250);
    };
    playerTickTimer = setTimeout(tick, 250);
  }

  function renderPlayerActionArea(alive) {
    const area = document.getElementById('ww-pl-action-area');
    area.innerHTML = '';

    if (!state.players.some((p) => p.id === session.clientId)) {
      area.innerHTML = `<div class="sleep-box"><span class="sleep-icon" aria-hidden="true">👀</span><p>Đang có ván chơi — bạn xem ké nhé, chờ ván sau để vào chơi cùng cả hội!</p></div>`;
      return;
    }

    if (state.phase === 'GAME_OVER') {
      window.WWViews.playerGameOver(area, buildGameOverVm(state, session.clientId), { onOpenLog: openPlayerLog });
      return;
    }

    if (state.phase === 'HUNTER_REVENGE') {
      if (state.pendingHunterId === session.clientId) {
        renderHunterActionUI(area);
      } else {
        area.innerHTML = `<div class="sleep-box"><span class="sleep-icon" aria-hidden="true">🏹</span><p>Đang chờ Thợ Săn hô bắn và bấm xác nhận trên điện thoại...</p></div>`;
      }
      return;
    }

    if (state.phase === 'ROLE_REVEAL') {
      area.innerHTML = `<div class="sleep-box"><span class="sleep-icon" aria-hidden="true">🃏</span><p>Chạm vào thẻ bài phía trên để xem vai trò của bạn. Đêm 1 sắp bắt đầu!</p></div>`;
      return;
    }

    if (state.phase === 'DAY') {
      const h = document.createElement('h3');
      h.textContent = '☀️ Ban ngày — Tranh luận & Vote';
      area.appendChild(h);

      const summary = document.createElement('p');
      summary.textContent = state.lastDawnSummary || 'Mọi người hãy thảo luận tự do!';
      area.appendChild(summary);

      if (!alive) {
        const deadNote = document.createElement('p');
        deadNote.className = 'hint';
        deadNote.textContent = '💀 Bạn đã bị loại — không thể bỏ phiếu.';
        area.appendChild(deadNote);
        return;
      }

      if (state.revoteUsed) {
        const rv = document.createElement('p');
        rv.className = 'hint';
        rv.textContent = '🔁 Vòng bỏ phiếu lại: lần này hòa nữa thì không ai bị treo cổ.';
        area.appendChild(rv);
      }

      if (state.voteLock) {
        const cd = document.createElement('p');
        cd.id = 'ww-pl-vote-countdown';
        cd.className = 'vote-countdown';
        cd.textContent = voteCountdownText();
        area.appendChild(cd);
        ensurePlayerTick();
      }

      const voteLabel = document.createElement('p');
      voteLabel.className = 'panel-desc';
      voteLabel.textContent = 'Bầu chọn người nghi là Ma Sói (Bot sẽ cập nhật trực tiếp lên màn hình chính):';
      area.appendChild(voteLabel);

      const myVote = state.dayVotes ? state.dayVotes[session.clientId] : null;
      const grid = document.createElement('div');
      grid.className = 'target-grid';

      state.players
        .filter((p) => p.alive && p.id !== session.clientId)
        .forEach((p) => {
          grid.appendChild(
            makeTargetBtn(p, myVote === p.id ? `✓ Vote ${p.name}` : p.name, myVote === p.id, false, () => {
              session.send('WW_DAY_VOTE', { targetId: p.id });
            })
          );
        });

      const skipVoteBtn = document.createElement('button');
      skipVoteBtn.type = 'button';
      skipVoteBtn.className = `target-btn ${myVote === '__skip__' ? 'selected' : ''}`;
      skipVoteBtn.textContent = myVote === '__skip__' ? '✓ Phiếu trắng' : '🏳️ Bỏ phiếu trắng';
      skipVoteBtn.addEventListener('click', () => {
        session.send('WW_DAY_VOTE', { targetId: '__skip__' });
      });
      grid.appendChild(skipVoteBtn);

      area.appendChild(grid);
      return;
    }

    // NIGHT PHASE
    if (!alive) {
      area.innerHTML = `<div class="sleep-box"><span class="sleep-icon" aria-hidden="true">💀</span><p>Bạn đã bị loại. Hãy giữ im lặng hoàn toàn và theo dõi ván đấu.</p></div>`;
      return;
    }

    const myRole = clientSecret?.roleId;
    const activeTurn =
      myRole &&
      (state.nightStep === myRole || (state.nightStep === 'werewolf' && isWolfRole(myRole)));
    if (!activeTurn) {
      area.innerHTML = `<div class="sleep-box"><span class="sleep-icon" aria-hidden="true">🌙</span><p>Đang trong đêm... Hãy nhắm mắt lại và lắng nghe Bot Quản Trò.</p></div>`;
      return;
    }

    if (state.nightStep === 'cupid') renderCupidActionUI(area);
    else if (state.nightStep === 'guard') renderGuardActionUI(area);
    else if (state.nightStep === 'werewolf') renderWerewolfActionUI(area);
    else if (state.nightStep === 'alpha_wolf') renderAlphaWolfActionUI(area);
    else if (state.nightStep === 'seer') renderSeerActionUI(area);
    else if (state.nightStep === 'witch') renderWitchActionUI(area);
    else if (state.nightStep === 'serial_killer') renderSerialKillerActionUI(area);
  }

  function nameOfPublic(id) {
    const p = state && state.players ? state.players.find((x) => x.id === id) : null;
    return p ? p.name : '?';
  }

  function renderHunterActionUI(area) {
    const title = document.createElement('h3');
    title.textContent = '🏹 Bạn là Thợ Săn vừa ngã xuống!';
    area.appendChild(title);

    const guide = document.createElement('p');
    guide.className = 'panel-desc';
    guide.textContent = 'Hãy hô bắn ở ngoài đời, chạm tên người bị bắn rồi bấm nút Bắn bên dưới (không đổi lại được):';
    area.appendChild(guide);

    const grid = document.createElement('div');
    grid.className = 'target-grid';
    state.players
      .filter((p) => p.alive && p.id !== session.clientId)
      .forEach((p) => {
        grid.appendChild(
          makeTargetBtn(p, `🎯 ${p.name}`, selectedHunterTarget === p.id, false, () => {
            selectedHunterTarget = p.id;
            renderPlayer();
          })
        );
      });
    area.appendChild(grid);

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'btn btn-secondary btn-block';
    skipBtn.textContent = 'Không bắn ai';
    skipBtn.addEventListener('click', () => {
      sendAction({ step: 'hunter', targetId: null });
    });
    area.appendChild(skipBtn);

    window.WWViews.confirmBar(area, {
      label: selectedHunterTarget ? `🏹 Bắn ${nameOfPublic(selectedHunterTarget)}` : '🏹 Chọn người để bắn',
      enabled: Boolean(selectedHunterTarget),
      tone: 'danger',
      hint: '👆 Chạm tên người bị bắn ở phía trên',
      onConfirm: () => sendAction({ step: 'hunter', targetId: selectedHunterTarget })
    });
  }

  function renderCupidActionUI(area) {
    const h = document.createElement('h3');
    h.textContent = '💘 Lượt Thần Tình Yêu: Chọn 2 người để ghép đôi';
    area.appendChild(h);

    const hint = document.createElement('p');
    hint.className = 'panel-desc';
    hint.textContent = `Đã chọn ${selectedCupidTargets.length}/2 người (có thể chọn cả chính mình):`;
    area.appendChild(hint);

    const grid = document.createElement('div');
    grid.className = 'target-grid';
    state.players
      .filter((p) => p.alive)
      .forEach((p) => {
        const isSel = selectedCupidTargets.includes(p.id);
        grid.appendChild(
          makeTargetBtn(p, isSel ? `💘 ${p.name}` : p.name, isSel, false, () => {
            if (selectedCupidTargets.includes(p.id)) {
              selectedCupidTargets = selectedCupidTargets.filter((id) => id !== p.id);
            } else if (selectedCupidTargets.length < 2) {
              selectedCupidTargets = [...selectedCupidTargets, p.id];
            } else {
              selectedCupidTargets = [selectedCupidTargets[1], p.id];
            }
            renderPlayer();
          })
        );
      });
    area.appendChild(grid);

    window.WWViews.confirmBar(area, {
      label: '💘 Xác nhận ghép đôi Tình Nhân',
      enabled: selectedCupidTargets.length === 2,
      tone: 'primary',
      hint: '👆 Chọn đủ 2 người ở phía trên',
      onConfirm: () => sendAction({ step: 'cupid', targetIds: selectedCupidTargets })
    });
  }

  function renderAlphaWolfActionUI(area) {
    const h = document.createElement('h3');
    h.textContent = '🩸 Lượt Sói Đầu Đàn (Kỹ năng Nguyền Hóa)';
    area.appendChild(h);

    const victimName = alphaInfo?.victimName;
    const canConvert = Boolean(alphaInfo?.canConvert && victimName);

    const infoBox = document.createElement('div');
    infoBox.className = 'result-banner';
    infoBox.innerHTML = victimName
      ? `Đêm nay bầy Sói đã chọn cắn <strong>${escapeHtml(victimName)}</strong>. Bạn có muốn dùng quyền Nguyền <strong>1 lần duy nhất</strong> biến người này thành Ma Sói thay vì giết họ không?`
      : 'Đêm nay chưa có mục tiêu để nguyền hóa.';
    area.appendChild(infoBox);

    const bar = document.createElement('div');
    bar.className = 'sticky-action-bar ww-alpha-bar';
    if (canConvert) {
      const convertBtn = document.createElement('button');
      convertBtn.type = 'button';
      convertBtn.className = 'btn btn-danger btn-lg btn-block';
      convertBtn.textContent = `🩸 Nguyền hóa ${victimName} thành Ma Sói`;
      convertBtn.addEventListener('click', () => sendAction({ step: 'alpha_wolf', convert: true }));
      bar.appendChild(convertBtn);
    }

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'btn btn-secondary btn-lg btn-block';
    skipBtn.textContent = '⏭️ Không nguyền (Để Sói cắn như bình thường)';
    skipBtn.addEventListener('click', () => sendAction({ step: 'alpha_wolf', convert: false }));
    bar.appendChild(skipBtn);
    area.appendChild(bar);
  }

  function renderSerialKillerActionUI(area) {
    const h = document.createElement('h3');
    h.textContent = '🗡️ Lượt Sát Nhân Độc Hành: Chọn mục tiêu đêm nay';
    area.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'target-grid';
    state.players
      .filter((p) => p.alive && p.id !== session.clientId)
      .forEach((p) => {
        grid.appendChild(
          makeTargetBtn(p, `🗡️ ${p.name}`, selectedNightTarget === p.id, false, () => {
            selectedNightTarget = p.id;
            renderPlayer();
          })
        );
      });
    area.appendChild(grid);

    window.WWViews.confirmBar(area, {
      label: selectedNightTarget ? `🗡️ Ám sát ${nameOfPublic(selectedNightTarget)}` : '🗡️ Ám sát người này',
      enabled: Boolean(selectedNightTarget),
      tone: 'danger',
      hint: '👆 Chạm tên mục tiêu ở phía trên',
      onConfirm: () => sendAction({ step: 'serial_killer', targetId: selectedNightTarget })
    });
  }

  function renderGuardActionUI(area) {
    const h = document.createElement('h3');
    h.textContent = '🛡️ Lượt Bảo Vệ: Chọn 1 người để che chở đêm nay';
    area.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'target-grid';
    state.players
      .filter((p) => p.alive)
      .forEach((p) => {
        const blocked = state.lastGuardedId === p.id;
        grid.appendChild(
          makeTargetBtn(p, blocked ? `${p.name} (Đêm trước)` : p.name, selectedNightTarget === p.id, blocked, () => {
            selectedNightTarget = p.id;
            renderPlayer();
          })
        );
      });
    area.appendChild(grid);

    window.WWViews.confirmBar(area, {
      label: selectedNightTarget ? `🛡️ Bảo vệ ${nameOfPublic(selectedNightTarget)}` : '🛡️ Xác nhận bảo vệ',
      enabled: Boolean(selectedNightTarget),
      tone: 'primary',
      hint: '👆 Chạm tên người cần bảo vệ ở phía trên',
      onConfirm: () => sendAction({ step: 'guard', targetId: selectedNightTarget })
    });
  }

  // ----- Bầy Sói: nút "đổ đầy" theo số Sói đã chọn; cả bầy cùng chọn -> tự chốt sau 3 giây -----
  function buildWolfVm() {
    const myId = session.clientId;
    const votes = wolfSync.wolfVotes || {};
    const mateIds = new Set(((clientSecret && clientSecret.teammates) || []).map((m) => m.id));
    const loverId = (clientSecret && clientSecret.loverInfo && clientSecret.loverInfo.id) || null;
    const candidates = state.players
      .filter((p) => p.alive && p.id !== myId && !mateIds.has(p.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        avatarId: c.avatarId,
        isMyLover: c.id === loverId,
        pickedBy: Object.entries(votes)
          .filter(([, tId]) => tId === c.id)
          .map(([wId]) => {
            const w = state.players.find((x) => x.id === wId);
            return { id: wId, name: w ? w.name : '?', avatarId: w ? w.avatarId : '', isMe: wId === myId };
          })
      }));
    return {
      wolfCount: wolfSync.wolfCount,
      myPickId: votes[myId] || null,
      candidates,
      lock: wolfSync.lock
        ? { targetId: wolfSync.lock.targetId, remainingMs: Math.max(0, wolfLockEndLocal - Date.now()) }
        : null
    };
  }

  function renderWerewolfActionUI(area) {
    window.WWViews.wolfVotePanel(area, buildWolfVm(), {
      onPick: (targetId) => {
        // Cập nhật ngay trên máy mình; host sẽ gửi lại bản đồng bộ chính thức.
        wolfSync = { ...wolfSync, wolfVotes: { ...wolfSync.wolfVotes, [session.clientId]: targetId }, lock: null };
        wolfLockEndLocal = 0;
        sendAction({ step: 'werewolf', targetId });
        renderPlayer();
      }
    });
  }

  function renderSeerActionUI(area) {
    const h = document.createElement('h3');
    h.textContent = '🔮 Lượt Tiên Tri';
    area.appendChild(h);

    if (seerResult) {
      const resBox = document.createElement('div');
      resBox.className = 'alert-box';
      resBox.innerHTML = seerResult.isWolf
        ? `<strong>🐺 ${escapeHtml(seerResult.targetName)} thuộc PHE MA SÓI!</strong>`
        : `<strong>🧑‍🌾 ${escapeHtml(seerResult.targetName)} thuộc PHE DÂN LÀNG!</strong>`;
      area.appendChild(resBox);

      window.WWViews.confirmBar(area, {
        label: 'Đã xem xong — Nhắm mắt lại',
        enabled: true,
        tone: 'primary',
        onConfirm: () => sendAction({ step: 'seer', action: 'done' })
      });
      return;
    }

    const inspectedSet = new Set(state.seerHistory || []);
    const candidates = state.players.filter((p) => p.alive && p.id !== session.clientId);
    const hasUninspected = candidates.some((p) => !inspectedSet.has(p.id));

    const pNote = document.createElement('p');
    pNote.className = 'panel-desc';
    pNote.textContent = hasUninspected
      ? 'Chọn 1 người chưa soi để biết họ có phải Ma Sói hay không:'
      : 'Bạn đã soi hết tất cả người chơi còn sống! Hãy ấn xong để tiếp tục.';
    area.appendChild(pNote);

    const grid = document.createElement('div');
    grid.className = 'target-grid';
    candidates.forEach((p) => {
      const alreadyDone = inspectedSet.has(p.id);
      grid.appendChild(
        makeTargetBtn(p, alreadyDone ? `${p.name} (Đã soi đêm trước)` : `🔮 ${p.name}`, false, alreadyDone, () => {
          sendAction({ step: 'seer', action: 'inspect', targetId: p.id });
        })
      );
    });
    area.appendChild(grid);

    if (!hasUninspected) {
      window.WWViews.confirmBar(area, {
        label: 'Nhắm mắt lại',
        enabled: true,
        tone: 'primary',
        onConfirm: () => sendAction({ step: 'seer', action: 'done' })
      });
    }
  }

  function witchConfirmLabel(info) {
    const save = witchSaveChoice && info.victimName ? `Cứu ${info.victimName}` : '';
    const target = witchPoisonChoice ? nameOfPublic(witchPoisonChoice) : '';
    if (save && target) return `🧪 Xong lượt Phù Thủy — ${save} & đầu độc ${target}`;
    if (save) return `🧪 Xong lượt Phù Thủy — ${save}`;
    if (target) return `🧪 Xong lượt Phù Thủy — Đầu độc ${target}`;
    return '🧪 Xong lượt Phù Thủy — Nhắm mắt lại';
  }

  function renderWitchActionUI(area) {
    const h = document.createElement('h3');
    h.textContent = '🧪 Lượt Phù Thủy';
    area.appendChild(h);

    const info = witchInfo || { victimId: null, victimName: null, canSave: false, canPoison: false };

    const saveBox = document.createElement('div');
    saveBox.className = 'result-banner';
    if (!info.canSave) {
      saveBox.textContent = '💚 Bình Cứu: Đã dùng hết ở đêm trước.';
    } else if (!info.victimName) {
      saveBox.textContent = '💚 Bình Cứu: Đêm nay không có nạn nhân nào bị Sói cắn.';
    } else {
      saveBox.innerHTML = `<p>Đêm nay <strong>${escapeHtml(info.victimName)}</strong> vừa bị Sói cắn!</p>`;
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = `btn btn-block ${witchSaveChoice ? 'btn-success' : 'btn-secondary'}`;
      saveBtn.textContent = witchSaveChoice ? `✅ Đã chọn CỨU ${info.victimName}` : `💚 Dùng Bình Cứu ${info.victimName}`;
      saveBtn.addEventListener('click', () => {
        witchSaveChoice = !witchSaveChoice;
        if (witchSaveChoice && info.victimId && witchPoisonChoice === info.victimId) {
          witchPoisonChoice = null;
        }
        renderPlayer();
      });
      saveBox.appendChild(saveBtn);
    }
    area.appendChild(saveBox);

    const poisonWrap = document.createElement('div');
    if (!info.canPoison) {
      const pTxt = document.createElement('p');
      pTxt.className = 'hint';
      pTxt.textContent = '☠️ Bình Độc: Đã dùng hết ở đêm trước.';
      poisonWrap.appendChild(pTxt);
    } else {
      const pTxt = document.createElement('p');
      pTxt.textContent = '☠️ Bình Độc (tùy chọn): Chọn 1 người để đầu độc, hoặc bỏ qua:';
      poisonWrap.appendChild(pTxt);

      const grid = document.createElement('div');
      grid.className = 'target-grid';
      state.players
        .filter((p) => p.alive && p.id !== session.clientId && !(witchSaveChoice && info.victimId === p.id))
        .forEach((p) => {
          grid.appendChild(
            makeTargetBtn(p, `☠️ ${p.name}`, witchPoisonChoice === p.id, false, () => {
              witchPoisonChoice = witchPoisonChoice === p.id ? null : p.id;
              renderPlayer();
            })
          );
        });
      poisonWrap.appendChild(grid);
    }
    area.appendChild(poisonWrap);

    window.WWViews.confirmBar(area, {
      label: witchConfirmLabel(info),
      enabled: true,
      tone: 'primary',
      onConfirm: () =>
        sendAction({ step: 'witch', useSave: witchSaveChoice, poisonTargetId: witchPoisonChoice })
    });
  }

  function updateNetBadge(id, text, online) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = `net-badge ${online ? '' : 'offline'}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    startHost,
    joinAsPlayer,
    cleanup,
    getHostSnapshotInfo,
    discardHostSnapshot
  };
})();
