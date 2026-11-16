// Game 2: Gián Điệp v3.1 — Laptop Quản Trò, phiếu thăm dò trên điện thoại, hoạt cảnh & pháo giấy chiến thắng
window.SpyGame = (() => {
  const {
    SPY_CARD_THEMES,
    UNDERCOVER_DECKS,
    getDeckPairs,
    TWIST_QUESTION_PAIRS,
    SPYFALL_LOCATIONS,
    SPYFALL_QUESTIONS,
    ROUND_SPARKS,
    getRandomAvatarId
  } = window.GameData;

  let session = null;
  let isHost = false;
  let myName = '';
  let myAvatarId = '';
  let state = null;
  let mySecret = null; // { mode, role, word, hint, question, location, locRole }
  let cardRevealed = false;
  let crossedLocations = new Set();
  let lastReceivedSeq = -1;
  let lastSceneKey = '';
  let demoCounter = 1;
  let voteAllAnnounced = false;
  let lastBeaconJoinAt = 0;
  const SNAPSHOT_KEY = 'hq_spy_host_snapshot';

  function snapshotKey() {
    return window.RoomNetwork.storageKey(SNAPSHOT_KEY);
  }

  function randomEpoch() {
    return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function computeMaxSpyVotes(playerCount, spyCount, hasMrWhite, mode) {
    if (mode === 'spyfall') {
      return Math.max(1, spyCount || 1);
    }
    const badCount = (spyCount || 1) + (hasMrWhite ? 1 : 0);
    let allowedMistakes = 0;
    if (playerCount >= 9) allowedMistakes = 3;
    else if (playerCount >= 7) allowedMistakes = 2;
    else if (playerCount >= 5) allowedMistakes = 1;
    return badCount + allowedMistakes;
  }

  function createInitialState() {
    return {
      stateSeq: 0,
      epoch: randomEpoch(),
      roomCode: window.RoomNetwork.ROOM_ID,
      hostId: null,
      phase: 'LOBBY', // LOBBY | PLAYING | MR_WHITE_GUESS | GAME_OVER
      config: {
        mode: 'undercover', // 'undercover' | 'twist' | 'spyfall'
        deckKey: 'all',
        spyCount: 1,
        mrWhite: false
      },
      round: 1,
      maxVotes: 1,
      votesUsed: 0,
      aliveBadCount: 1,
      botText: 'Chờ mọi người quét QR vào phòng và ấn Sẵn sàng...',
      roundSpark: '',
      twistQuestionRevealed: false,
      revealedQuestionText: '',
      players: [], // { id, name, avatarId, ready, alive, isDemo, role (host-only), word, locRole }
      turnOrder: [],
      votes: {},
      pendingMrWhiteId: null,
      winner: null, // 'civilian' | 'spy' | 'mr_white'
      winReason: '',
      answerSummary: null,
      crossedResetToken: 0
    };
  }

  function getPublicState(s) {
    const revealAll = s.phase === 'GAME_OVER';
    const aliveBadCount = (s.players || []).filter(
      (p) => p.alive && (p.role === 'spy' || p.role === 'mr_white')
    ).length;
    return {
      stateSeq: s.stateSeq,
      epoch: s.epoch,
      roomCode: s.roomCode,
      hostId: s.hostId,
      phase: s.phase,
      config: s.config,
      round: s.round,
      maxVotes: s.maxVotes || 1,
      votesUsed: s.votesUsed || 0,
      aliveBadCount: s.phase === 'LOBBY' ? s.config.spyCount || 1 : aliveBadCount,
      botText: s.botText || '',
      roundSpark: s.roundSpark,
      twistQuestionRevealed: s.twistQuestionRevealed,
      revealedQuestionText: s.twistQuestionRevealed || revealAll ? s.revealedQuestionText : '',
      turnOrder: s.turnOrder,
      votes: s.votes,
      pendingMrWhiteId: s.pendingMrWhiteId,
      winner: s.winner,
      winReason: s.winReason,
      answerSummary: revealAll ? s.answerSummary : null,
      crossedResetToken: s.crossedResetToken,
      players: s.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatarId: p.avatarId || 'boy_smile',
        ready: p.ready,
        alive: p.alive,
        isDemo: p.isDemo,
        online: Boolean(
          p.isDemo || (session && session.isClientOnline ? session.isClientOnline(p.id) : true)
        ),
        revealedRole: !p.alive || revealAll ? p.role : null,
        role: revealAll ? p.role : null,
        word: revealAll ? p.word : null,
        locRole: revealAll ? p.locRole : null
      }))
    };
  }

  function syncStateToClients() {
    if (!isHost || !session || !state) return;
    state.stateSeq += 1;
    session.send('SPY_STATE', getPublicState(state));
    if (session.setBeaconInfo) {
      session.setBeaconInfo({ phase: state.phase, stateSeq: state.stateSeq, epoch: state.epoch });
    }
    saveHostSnapshot();
  }

  // ==================== HOST SNAPSHOT ====================
  function saveHostSnapshot() {
    if (!isHost || !state) return;
    try {
      localStorage.setItem(
        snapshotKey(),
        JSON.stringify({ v: 1, savedAt: Date.now(), state, demoCounter, voteAllAnnounced })
      );
    } catch (_) {}
  }

  function readHostSnapshot() {
    try {
      const raw = localStorage.getItem(snapshotKey());
      if (!raw) return null;
      const snap = JSON.parse(raw);
      if (!snap || !snap.state || !Array.isArray(snap.state.players) || !snap.state.phase) return null;
      if (!snap.state.config || typeof snap.state.stateSeq !== 'number') return null;
      return snap;
    } catch (_) {
      return null;
    }
  }

  function getHostSnapshotInfo() {
    const snap = readHostSnapshot();
    if (!snap) return null;
    return {
      phase: snap.state.phase,
      playerCount: snap.state.players.length,
      savedAt: snap.savedAt || 0
    };
  }

  function discardHostSnapshot() {
    try {
      localStorage.removeItem(snapshotKey());
    } catch (_) {}
  }

  // Đổi id người chơi (thiết bị mới / xoá dữ liệu trình duyệt) — sửa mọi chỗ lưu id.
  function remapPlayerId(oldId, newId) {
    if (!state || oldId === newId) return;
    state.players.forEach((p) => {
      if (p.id === oldId) p.id = newId;
    });
    const newVotes = {};
    Object.entries(state.votes || {}).forEach(([voterId, targetId]) => {
      newVotes[voterId === oldId ? newId : voterId] = targetId === oldId ? newId : targetId;
    });
    state.votes = newVotes;
    state.turnOrder = (state.turnOrder || []).map((id) => (id === oldId ? newId : id));
    if (state.pendingMrWhiteId === oldId) state.pendingMrWhiteId = newId;
  }

  function setSpyBotSpeech(text) {
    if (!state) return;
    state.botText = text;
    syncStateToClients();
    render();
    window.AudioEngine.speak(text);
  }

  function deliverSecretToPlayer(player) {
    if (!isHost || !state) return;
    const secretPayload = {
      mode: state.config.mode,
      role: player.role,
      word: player.word || null,
      hint: state.answerSummary ? state.answerSummary.hint || null : null,
      question: player.question || null,
      // Tuyệt đối không gửi địa điểm bí mật cho Gián Điệp trong chế độ Spyfall.
      location:
        player.role !== 'spy' && state.answerSummary ? state.answerSummary.location : null,
      locRole: player.locRole || null
    };

    if (player.id === session.clientId) {
      mySecret = secretPayload;
    } else if (!player.isDemo && session) {
      session.send('SPY_SECRET', secretPayload, player.id);
    }
  }

  // ==================== ENTRY POINTS ====================
  function startHost({ resume = false } = {}) {
    cleanup();
    isHost = true;
    myName = 'Quản Trò';
    myAvatarId = '';
    demoCounter = 1;
    voteAllAnnounced = false;

    const snap = resume ? readHostSnapshot() : null;
    if (snap) {
      state = snap.state;
      demoCounter = snap.demoCounter || 1;
      voteAllAnnounced = Boolean(snap.voteAllAnnounced);
      if (!state.epoch) state.epoch = randomEpoch();
      state.votes = state.votes || {};
      state.turnOrder = state.turnOrder || [];
      lastSceneKey = `${state.phase}:${state.round}:${state.winner || ''}`;
    } else {
      state = createInitialState();
    }

    session = window.RoomNetwork.createSession({
      gameType: 'spy',
      isHost: true,
      onMessage: handleHostMessage,
      onStatus: (txt, ok) => updateNetBadge('spy-net-status', txt, ok),
      onPresence: () => {
        if (!isHost || !state) return;
        syncStateToClients();
        render();
      },
      onSuperseded: () => {
        window.AppUI.showToast('Máy khác đã tiếp quản vai trò Quản Trò.');
        if (window.AppUI.clearSession) window.AppUI.clearSession();
        cleanup();
        window.AppUI.goHome();
      }
    });

    state.hostId = session.clientId;
    // Laptop chỉ đóng vai Quản Trò Dẫn Chuyện — không thêm vào danh sách người chơi!
    if (window.AppUI.markSession) window.AppUI.markSession('host', 'spy');
    if (session.setBeaconInfo) {
      session.setBeaconInfo({ phase: state.phase, stateSeq: state.stateSeq, epoch: state.epoch });
    }

    bindEvents();
    renderShareBox();
    window.AppUI.showView('view-spy-room');
    render();
    syncStateToClients(); // cũng lưu snapshot (ghi đè snapshot cũ khi bắt đầu mới)

    if (snap && state.phase !== 'LOBBY') {
      if (state.botText) window.AudioEngine.speak(state.botText);
      if (state.phase === 'MR_WHITE_GUESS') {
        const mw = state.players.find((p) => p.id === state.pendingMrWhiteId);
        if (mw && mw.isDemo) setTimeout(() => resolveMrWhiteGuess(''), 1400);
      }
    }
  }

  function joinAsPlayer(playerName, playerAvatarId) {
    cleanup();
    isHost = false;
    myName = playerName;
    myAvatarId = playerAvatarId || window.AppUI.getSavedAvatarId();
    lastReceivedSeq = -1;
    lastBeaconJoinAt = 0;
    state = createInitialState();
    state.epoch = null; // sẽ nhận epoch thật từ Quản Trò

    const announceJoin = () => {
      if (!session || isHost) return;
      session.send('SPY_JOIN', { name: myName, avatarId: myAvatarId });
    };

    session = window.RoomNetwork.createSession({
      gameType: 'spy',
      isHost: false,
      onMessage: handleClientMessage,
      onStatus: (txt, ok) => updateNetBadge('spy-net-status', txt, ok),
      onConnected: announceJoin,
      onBeacon: (b) => {
        if (!b || b.game !== 'spy' || !state || isHost) return;
        if (b.epoch !== state.epoch || b.stateSeq !== lastReceivedSeq) {
          const now = Date.now();
          if (now - lastBeaconJoinAt >= 1500) {
            lastBeaconJoinAt = now;
            announceJoin();
          }
        }
      }
    });

    if (window.AppUI.markSession) window.AppUI.markSession('player', 'spy');
    bindEvents();
    window.AppUI.showView('view-spy-room');
    render();

    announceJoin();
  }

  function cleanup() {
    lastSceneKey = '';
    window.AudioEngine.stopSpeech();
    window.AudioEngine.stopNightAmbience();
    if (session) {
      session.destroy();
      session = null;
    }
    state = null;
    mySecret = null;
    cardRevealed = false;
    crossedLocations.clear();
  }

  // ==================== HOST MESSAGE HANDLER ====================
  function handleHostMessage(msg) {
    if (!state) return;
    const { senderId, type, payload } = msg;

    if (type === 'SPY_JOIN') {
      const cleanName = String(payload.name || 'Người chơi').trim().slice(0, 20) || 'Người chơi';
      const avatarId = payload.avatarId || getRandomAvatarId(state.players.length);
      let player = state.players.find((p) => p.id === senderId);
      let changed = false;
      if (!player) {
        if (state.phase !== 'LOBBY') {
          const byName = state.players.find(
            (p) => p.name.toLowerCase() === cleanName.toLowerCase() && !p.isDemo
          );
          if (byName) {
            remapPlayerId(byName.id, senderId);
            if (payload.avatarId) byName.avatarId = payload.avatarId;
            syncStateToClients();
            render();
            deliverSecretToPlayer(byName);
          }
          return;
        }
        player = {
          id: senderId,
          name: cleanName,
          avatarId,
          ready: false,
          alive: true,
          isDemo: false,
          role: null
        };
        state.players.push(player);
        changed = true;
      } else if (state.phase === 'LOBBY') {
        if (player.name !== cleanName) {
          player.name = cleanName;
          changed = true;
        }
        if (payload.avatarId && player.avatarId !== payload.avatarId) {
          player.avatarId = payload.avatarId;
          changed = true;
        }
      }

      if (changed) {
        syncStateToClients();
        render();
      } else {
        // JOIN lặp lại: chỉ gửi lại trạng thái hiện tại cho người này (idempotent)
        session.send('SPY_STATE', getPublicState(state), senderId);
      }
      if (state.phase !== 'LOBBY') {
        deliverSecretToPlayer(player);
      }
      return;
    }

    if (type === 'SPY_RENAME') {
      const p = state.players.find((x) => x.id === senderId);
      if (p && state.phase === 'LOBBY') {
        p.name = String(payload.name || p.name).trim().slice(0, 20) || p.name;
        if (payload.avatarId) p.avatarId = payload.avatarId;
        syncStateToClients();
        render();
      }
      return;
    }

    if (type === 'SPY_READY') {
      const p = state.players.find((x) => x.id === senderId);
      if (p && state.phase === 'LOBBY') {
        p.ready = Boolean(payload.ready);
        syncStateToClients();
        render();
      }
      return;
    }

    if (type === 'SPY_LEAVE') {
      if (state.phase === 'LOBBY') {
        state.players = state.players.filter((x) => x.id !== senderId);
        syncStateToClients();
        render();
      }
      return;
    }

    if (type === 'SPY_VOTE' && state.phase === 'PLAYING') {
      recordSpyVote(senderId, payload.targetId);
      return;
    }

    if (type === 'SPY_MRWHITE_GUESS' && state.phase === 'MR_WHITE_GUESS' && senderId === state.pendingMrWhiteId) {
      resolveMrWhiteGuess(payload.guessText || '');
      return;
    }

    if (type === 'SPY_LOCATION_GUESS' && state.phase === 'PLAYING') {
      const spy = state.players.find((x) => x.id === senderId && x.alive && x.role === 'spy');
      if (spy) {
        resolveSpyfallLocationGuess(spy, payload.location || '');
      }
    }
  }

  function recordSpyVote(voterId, targetId) {
    const voter = state.players.find((x) => x.id === voterId && x.alive);
    const target = state.players.find((x) => x.id === targetId && x.alive);
    if (!voter || !target || voter.id === target.id) return;
    state.votes[voterId] = targetId;
    syncStateToClients();
    render();
    checkAllSpyVoted();
  }

  function checkAllSpyVoted() {
    if (voteAllAnnounced || !state || state.phase !== 'PLAYING') return;
    const realAlive = state.players.filter((p) => p.alive && !p.isDemo);
    if (realAlive.length === 0) return;
    if (realAlive.every((p) => Boolean(state.votes[p.id]))) {
      voteAllAnnounced = true;
      saveHostSnapshot();
      window.AudioEngine.playVoteGavel();
      const sorted = Object.entries(getVoteCounts()).sort((a, b) => b[1] - a[1]);
      if (sorted[0]) {
        const topPlayer = state.players.find((p) => p.id === sorted[0][0]);
        window.AudioEngine.speak(
          `Mọi người đã bỏ phiếu xong! ${topPlayer ? topPlayer.name : ''} đang có nhiều phiếu nghi ngờ nhất.`
        );
      }
    }
  }

  // ==================== HOST GAME LOGIC ====================
  function startNewRoundGame() {
    if (!isHost || !state) return;
    window.AudioEngine.unlock();

    const n = state.players.length;
    const spiesWanted = Math.min(state.config.spyCount || 1, Math.max(1, Math.floor((n - 1) / 2)));
    const wantMrWhite = state.config.mode === 'undercover' && state.config.mrWhite && n >= spiesWanted + 2;

    const indices = state.players.map((_, i) => i);
    shuffle(indices);

    state.round = 1;
    state.votesUsed = 0;
    state.maxVotes = computeMaxSpyVotes(n, spiesWanted, wantMrWhite, state.config.mode);
    state.votes = {};
    voteAllAnnounced = false;
    state.pendingMrWhiteId = null;
    state.winner = null;
    state.winReason = '';
    state.twistQuestionRevealed = false;
    state.revealedQuestionText = '';
    state.crossedResetToken += 1;
    crossedLocations.clear();
    cardRevealed = false;

    lastSceneKey = '';
    state.players.forEach((p) => {
      p.alive = true;
      p.role = 'civilian';
      p.word = null;
      p.question = null;
      p.locRole = null;
    });

    if (state.config.mode === 'undercover') {
      const pairs = getDeckPairs(state.config.deckKey);
      const pair = pairs[Math.floor(Math.random() * pairs.length)];
      const flip = Math.random() < 0.5;
      const civilianWord = flip ? pair[0] : pair[1];
      const spyWord = flip ? pair[1] : pair[0];

      for (let i = 0; i < spiesWanted; i++) {
        state.players[indices[i]].role = 'spy';
        state.players[indices[i]].word = spyWord;
      }
      if (wantMrWhite) {
        state.players[indices[spiesWanted]].role = 'mr_white';
        state.players[indices[spiesWanted]].word = null;
      }
      state.players.forEach((p) => {
        if (p.role === 'civilian') p.word = civilianWord;
      });

      state.answerSummary = {
        mode: 'undercover',
        category: pair[2] || 'Chung',
        hint: pair[3] || '',
        civilianWord,
        spyWord,
        location: null
      };
      state.roundSpark = ROUND_SPARKS[0];
    } else if (state.config.mode === 'twist') {
      const pair = TWIST_QUESTION_PAIRS[Math.floor(Math.random() * TWIST_QUESTION_PAIRS.length)];
      const flip = Math.random() < 0.5;
      const qCiv = flip ? pair[0] : pair[1];
      const qSpy = flip ? pair[1] : pair[0];

      for (let i = 0; i < spiesWanted; i++) {
        state.players[indices[i]].role = 'spy';
        state.players[indices[i]].question = qSpy;
      }
      state.players.forEach((p) => {
        if (p.role === 'civilian') p.question = qCiv;
      });

      state.revealedQuestionText = qCiv;
      state.answerSummary = {
        mode: 'twist',
        category: pair[2] || 'Hỏi xoáy',
        civilianWord: qCiv,
        spyWord: qSpy,
        location: null
      };
      state.roundSpark = 'Mọi người lần lượt trả lời câu hỏi trên thẻ (cấm đọc đề), xong rồi bấm Lật Câu Hỏi Thật!';
    } else {
      const loc = SPYFALL_LOCATIONS[Math.floor(Math.random() * SPYFALL_LOCATIONS.length)];
      const shuffledRoles = [...loc.roles];
      shuffle(shuffledRoles);

      for (let i = 0; i < spiesWanted; i++) {
        state.players[indices[i]].role = 'spy';
      }
      let roleCursor = 0;
      state.players.forEach((p) => {
        if (p.role === 'civilian') {
          p.locRole = shuffledRoles[roleCursor % shuffledRoles.length];
          roleCursor += 1;
        }
      });

      state.answerSummary = {
        mode: 'spyfall',
        location: loc.name,
        civilianWord: null,
        spyWord: null
      };
      state.roundSpark = 'Đặt câu hỏi qua lại để tìm ai không biết địa điểm bí mật!';
    }

    const orderIds = state.players.map((p) => p.id);
    shuffle(orderIds);
    state.turnOrder = orderIds;
    state.phase = 'PLAYING';

    state.players.forEach((p) => deliverSecretToPlayer(p));
    syncStateToClients();
    render();
    window.AudioEngine.playRoosterDawn();

    const firstSpeaker = state.players.find((p) => p.id === state.turnOrder[0]);
    const voteBudgetNote = `Cả hội có tối đa ${state.maxVotes} lượt vote để tìm ra Gián Điệp.`;
    if (state.config.mode === 'undercover') {
      setSpyBotSpeech(
        `Ván Gián Điệp bắt đầu! Mọi người hãy giữ thẻ trên điện thoại để xem từ khóa. Người phát biểu đầu tiên là ${
          firstSpeaker ? firstSpeaker.name : ''
        }. ${voteBudgetNote}`
      );
    } else if (state.config.mode === 'twist') {
      setSpyBotSpeech(
        `Chế độ Hỏi Xoáy bắt đầu! Hãy đọc thầm câu hỏi trên điện thoại và lần lượt trả lời thành tiếng, bắt đầu từ ${
          firstSpeaker ? firstSpeaker.name : ''
        }! ${voteBudgetNote}`
      );
    } else {
      setSpyBotSpeech(
        `Spyfall bắt đầu! Dân thường hãy xem địa điểm bí mật, còn Gián Điệp hãy lắng nghe thật kỹ! ${voteBudgetNote}`
      );
    }
  }

  function revealTwistQuestion() {
    if (!isHost || !state || state.config.mode !== 'twist') return;
    state.twistQuestionRevealed = true;
    window.AudioEngine.playVoteGavel();
    setSpyBotSpeech(`Câu hỏi thật của Dân Thường là: ${state.revealedQuestionText}`);
  }

  function eliminatePlayer(targetId) {
    if (!isHost || !state || state.phase !== 'PLAYING') return;
    const target = state.players.find((p) => p.id === targetId && p.alive);
    if (!target) return;

    window.AudioEngine.playVoteGavel();
    window.SceneFX.flash('rgba(244, 63, 94, 0.22)');
    target.alive = false;
    state.votesUsed = (state.votesUsed || 0) + 1;
    state.votes = {};
    voteAllAnnounced = false;

    if (state.config.mode === 'undercover' && target.role === 'mr_white') {
      state.phase = 'MR_WHITE_GUESS';
      state.pendingMrWhiteId = target.id;
      const hostInput = document.getElementById('spy-host-mrwhite-input');
      if (hostInput) hostInput.value = '';
      setSpyBotSpeech(`${target.name} chính là Mr. White! Mời ${target.name} đoán từ khóa của Dân Thường.`);
      if (target.id === session.clientId) {
        openGuessDialog('mr_white');
      } else if (target.isDemo) {
        setTimeout(() => resolveMrWhiteGuess(''), 1400);
      }
      return;
    }

    evaluateAfterElimination(target);
  }

  function resolveMrWhiteGuess(guessText) {
    if (!state || state.phase !== 'MR_WHITE_GUESS') return;
    const mrWhite = state.players.find((p) => p.id === state.pendingMrWhiteId);
    state.pendingMrWhiteId = null;

    const cleanGuess = String(guessText || '').trim().toLowerCase().normalize('NFC');
    const cleanAnswer = String(state.answerSummary?.civilianWord || '').trim().toLowerCase().normalize('NFC');

    if (cleanGuess && cleanGuess === cleanAnswer) {
      endGame(
        'mr_white',
        `${mrWhite ? mrWhite.name : 'Mr. White'} đã đoán trúng từ khóa "${state.answerSummary.civilianWord}" và lật kèo chiến thắng!`
      );
      return;
    }

    window.AppUI.showToast(`Mr. White đoán "${guessText || '...'}" — Không chính xác!`);
    evaluateAfterElimination(mrWhite);
  }

  function resolveSpyfallLocationGuess(spyPlayer, guessedLocation) {
    const targetLoc = state.answerSummary?.location || '';
    if (guessedLocation === targetLoc) {
      endGame('spy', `Gián Điệp ${spyPlayer.name} đã đoán chính xác địa điểm "${targetLoc}"!`);
    } else {
      endGame(
        'civilian',
        `Gián Điệp ${spyPlayer.name} đoán nhầm thành "${guessedLocation}" (Đáp án đúng là "${targetLoc}"). Phe Dân Thường thắng!`
      );
    }
  }

  function evaluateAfterElimination(eliminated) {
    const alive = state.players.filter((p) => p.alive);
    const aliveBad = alive.filter((p) => p.role === 'spy' || p.role === 'mr_white');
    const aliveCiv = alive.filter((p) => p.role === 'civilian');
    const remainingVotes = Math.max(0, (state.maxVotes || 1) - (state.votesUsed || 0));

    if (state.config.mode === 'spyfall') {
      if (aliveBad.length === 0) {
        endGame('civilian', `Chính xác! Cả hội đã bắt đúng Gián Điệp ${eliminated ? eliminated.name : ''}!`);
        return;
      }
      if (eliminated && eliminated.role === 'civilian' && remainingVotes <= 0) {
        endGame('spy', `Bắt nhầm Dân Thường ${eliminated.name}! Hết lượt vote — Gián Điệp đã thoát thành công!`);
        return;
      }
      if (aliveBad.length >= aliveCiv.length) {
        endGame('spy', `Gián Điệp đã áp đảo số lượng Dân Thường! Phe Gián Điệp thắng!`);
        return;
      }
      advanceToNextRound(
        eliminated ? `${eliminated.name} (${eliminated.role === 'spy' ? 'Gián Điệp' : 'Dân Thường'}) đã bị loại! Còn ${remainingVotes} lượt vote.` : ''
      );
      return;
    }

    // Undercover & Twist
    if (aliveBad.length === 0) {
      endGame('civilian', 'Chính xác! Toàn bộ Gián Điệp đã bị vạch mặt! Phe Dân Thường chiến thắng!');
      return;
    }
    if (aliveBad.length >= aliveCiv.length) {
      endGame('spy', 'Số Gián Điệp còn lại đã ngang bằng Dân Thường! Phe Gián Điệp chiến thắng!');
      return;
    }
    if (remainingVotes <= 0) {
      endGame('spy', 'Cả hội đã dùng hết toàn bộ lượt Vote mà vẫn chưa bắt hết Gián Điệp! Phe Gián Điệp chiến thắng!');
      return;
    }

    const roleLabel =
      eliminated?.role === 'spy' ? 'Gián Điệp' : eliminated?.role === 'mr_white' ? 'Mr. White' : 'Dân Thường';
    advanceToNextRound(
      eliminated ? `${eliminated.name} là ${roleLabel}! Cả hội còn ${remainingVotes} lượt vote.` : ''
    );
  }

  function advanceToNextRound(notice) {
    state.phase = 'PLAYING';
    state.round += 1;
    state.votes = {};
    voteAllAnnounced = false;
    window.AudioEngine.playRoundSwell();
    state.roundSpark = ROUND_SPARKS[(state.round - 1) % ROUND_SPARKS.length];
    const aliveIds = state.players.filter((p) => p.alive).map((p) => p.id);
    shuffle(aliveIds);
    state.turnOrder = aliveIds;
    if (notice) {
      window.AppUI.showToast(notice);
      setSpyBotSpeech(`${notice} Bắt đầu vòng ${state.round}!`);
    } else {
      syncStateToClients();
      render();
    }
  }

  function endGame(winner, winReason) {
    state.phase = 'GAME_OVER';
    state.winner = winner;
    state.winReason = winReason;
    window.AudioEngine.playVictory();
    setSpyBotSpeech(winReason);
  }

  // ==================== CLIENT MESSAGE HANDLER ====================
  function handleClientMessage(msg) {
    if (!state) return;
    const { type, payload } = msg;

    if (type === 'SPY_STATE') {
      if (
        typeof payload.stateSeq === 'number' &&
        payload.phase !== 'LOBBY' &&
        payload.stateSeq < lastReceivedSeq
      ) {
        return;
      }
      if (payload.epoch && state.epoch && payload.epoch !== state.epoch) {
        // Quản Trò đã tạo phòng/ván mới → bỏ trạng thái cũ
        lastReceivedSeq = -1;
        mySecret = null;
        cardRevealed = false;
        crossedLocations.clear();
      }
      if (typeof payload.stateSeq === 'number') {
        lastReceivedSeq = payload.stateSeq;
      }

      const prevReset = state.crossedResetToken;
      state = { ...state, ...payload };
      const meSynced = (state.players || []).find((p) => p.id === session.clientId);
      if (meSynced && meSynced.avatarId) {
        myAvatarId = meSynced.avatarId;
      }
      if (state.phase === 'LOBBY') {
        mySecret = null;
        cardRevealed = false;
      }
      if (payload.crossedResetToken !== prevReset) {
        crossedLocations.clear();
        cardRevealed = false;
      }
      render();

      if (state.phase === 'MR_WHITE_GUESS' && state.pendingMrWhiteId === session.clientId) {
        openGuessDialog('mr_white');
      }
      return;
    }

    if (type === 'SPY_SECRET') {
      mySecret = payload;
      render();
    }
  }

  // ==================== UI BINDING & RENDER ====================
  function bindEvents() {
    document.getElementById('spy-copy-link').onclick = () => {
      const url = window.RoomNetwork.buildShareUrl();
      window.AppUI.copyText(url, 'Đã copy link mời vào Hội Quán!');
    };

    const openSpyQrZoom = () => {
      if (!state) return;
      const url = window.RoomNetwork.buildShareUrl();
      window.AppUI.openQrZoomModal('🕵️ Quét QR để mở app Hội Quán', window.RoomNetwork.ROOM_LABEL, url);
    };
    const spyQrEl = document.getElementById('spy-qr');
    const spyQrBtn = document.getElementById('spy-qr-zoom-btn');
    if (spyQrEl) spyQrEl.onclick = openSpyQrZoom;
    if (spyQrBtn) spyQrBtn.onclick = openSpyQrZoom;

    const spySoundBtn = document.getElementById('spy-ingame-sound');
    if (spySoundBtn) spySoundBtn.onclick = () => window.AppUI.openSoundSettings();

    const leaveRoom = async () => {
      if (!state) return;
      if (isHost) {
        if (state.phase !== 'LOBBY') {
          const ok = await window.AppUI.confirmDialog(
            'Thoát khỏi ván?',
            'Thoát sẽ KẾT THÚC ván Gián Điệp đang chơi của cả hội. Chắc chắn chứ?'
          );
          if (!ok) return;
        }
        discardHostSnapshot();
      } else {
        if (state.phase !== 'LOBBY') {
          const ok = await window.AppUI.confirmDialog(
            'Thoát khỏi ván?',
            'Bạn sẽ rời phòng. Vào lại vẫn tiếp tục được ván đang chơi.'
          );
          if (!ok) return;
        }
        if (session) session.send('SPY_LEAVE', {});
      }
      if (window.AppUI.clearSession) window.AppUI.clearSession();
      cleanup();
      window.AppUI.goHome();
    };

    document.getElementById('spy-leave').onclick = leaveRoom;
    document.getElementById('spy-ingame-leave').onclick = leaveRoom;

    const replaySpyVoice = () => {
      window.AudioEngine.unlock();
      if (state && state.botText) window.AudioEngine.speak(state.botText);
    };
    const spyReplayBtn = document.getElementById('spy-replay-bot');
    if (spyReplayBtn) spyReplayBtn.onclick = replaySpyVoice;

    const spyCodeEl = document.getElementById('spy-room-code');
    if (spyCodeEl) {
      spyCodeEl.style.cursor = 'pointer';
      spyCodeEl.title = 'Nhấn để copy link app';
      spyCodeEl.onclick = () => {
        window.AppUI.copyText(window.RoomNetwork.buildShareUrl(), 'Đã copy link app Hội Quán!');
      };
    }

    const fsBtn = document.getElementById('spy-ingame-fullscreen');
    if (fsBtn) {
      fsBtn.onclick = () => {
        try {
          if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
          else document.exitFullscreen?.();
        } catch (_) {}
      };
    }

    document.getElementById('spy-edit-name').onclick = async () => {
      const profile = await window.AppUI.promptProfileDialog(myName, myAvatarId);
      if (profile && (profile.name !== myName || profile.avatarId !== myAvatarId)) {
        myName = profile.name;
        myAvatarId = profile.avatarId;
        try {
          localStorage.setItem(window.RoomNetwork.storageKey('hq_player_name'), myName);
        } catch (_) {}
        window.AppUI.saveAvatarId(myAvatarId);
        if (isHost) {
          const me = state.players.find((p) => p.id === session.clientId);
          if (me) {
            me.name = myName;
            me.avatarId = myAvatarId;
          }
          syncStateToClients();
          render();
        } else {
          session.send('SPY_RENAME', { name: myName, avatarId: myAvatarId });
        }
      }
    };

    document.getElementById('spy-ready-btn').onclick = () => {
      window.AudioEngine.unlock();
      const me = state.players.find((p) => p.id === session.clientId);
      const nextReady = me ? !me.ready : true;
      if (isHost) {
        if (me) me.ready = nextReady;
        syncStateToClients();
        render();
      } else {
        session.send('SPY_READY', { ready: nextReady });
      }
    };

    document.getElementById('spy-add-demo').onclick = () => {
      if (!isHost || state.phase !== 'LOBBY') return;
      const demoNames = ['An', 'Bình', 'Chi', 'Dũng', 'Hà', 'Khánh', 'Linh', 'Ngọc'];
      const name = `${demoNames[(demoCounter - 1) % demoNames.length]} (Test ${demoCounter})`;
      const avatarId = getRandomAvatarId(state.players.length);
      demoCounter += 1;
      state.players.push({
        id: `spydemo_${Date.now()}_${demoCounter}`,
        name,
        avatarId,
        ready: true,
        alive: true,
        isDemo: true,
        role: null
      });
      syncStateToClients();
      render();
    };

    const cfgForm = document.getElementById('spy-config-form');
    cfgForm.onchange = () => {
      if (!isHost || !state || state.phase !== 'LOBBY') return;
      const modeInput = cfgForm.querySelector('input[name="spyMode"]:checked');
      state.config.mode = modeInput ? modeInput.value : 'undercover';
      state.config.deckKey = document.getElementById('spy-deck-select').value || 'all';
      state.config.spyCount = Number(document.getElementById('spy-count-select').value) || 1;
      state.config.mrWhite = document.getElementById('spy-mrwhite-check').checked;
      syncStateToClients();
      render();
    };

    document.getElementById('spy-start-btn').onclick = () => startNewRoundGame();

    window.AppUI.bindHoldToPeekCard(document.getElementById('spy-toggle-card'), (show) => {
      if (cardRevealed === show) return;
      cardRevealed = show;
      if (show && mySecret) {
        window.AudioEngine.unlock();
        window.AudioEngine.playCardFlip();
        window.SceneFX.sparkleAtElement(document.getElementById('spy-toggle-card'));
        setTimeout(() => window.AudioEngine.playRoleReveal(), 150);
      }
      renderSecretCard();
    });

    document.getElementById('spy-twist-reveal-btn').onclick = () => revealTwistQuestion();
    document.getElementById('spy-open-guess-location').onclick = () => openGuessDialog('spyfall');

    const hostMrWhiteForm = document.getElementById('spy-host-mrwhite-form');
    if (hostMrWhiteForm) {
      hostMrWhiteForm.onsubmit = (e) => {
        e.preventDefault();
        if (!isHost || !state || state.phase !== 'MR_WHITE_GUESS') return;
        const input = document.getElementById('spy-host-mrwhite-input');
        const val = input ? input.value.trim() : '';
        if (!val) return;
        resolveMrWhiteGuess(val);
      };
    }

    document.getElementById('spy-skip-round').onclick = () => {
      if (!isHost || state.phase !== 'PLAYING') return;
      window.AudioEngine.playVoteGavel();
      advanceToNextRound('Hòa phiếu! Chưa loại ai, chuyển sang vòng tiếp theo.');
    };

    document.getElementById('spy-play-again').onclick = () => resetToLobby();

    const resetBtn = document.getElementById('spy-host-reset-game');
    if (resetBtn) {
      resetBtn.onclick = async () => {
        if (!isHost || !state || state.phase === 'LOBBY') return;
        const ok = await window.AppUI.confirmDialog(
          'Reset ván?',
          'Ván Gián Điệp hiện tại sẽ bị huỷ và cả hội quay về sảnh chờ (giữ nguyên danh sách người chơi).'
        );
        if (ok) resetToLobby();
      };
    }
  }

  function resetToLobby() {
    if (!isHost || !state) return;
    state.phase = 'LOBBY';
    state.votes = {};
    voteAllAnnounced = false;
    state.winner = null;
    state.pendingMrWhiteId = null;
    state.twistQuestionRevealed = false;
    lastSceneKey = '';
    state.players.forEach((p) => {
      p.alive = true;
      p.role = null;
      if (!p.isDemo) p.ready = false;
    });
    syncStateToClients();
    render();
  }

  function openGuessDialog(kind) {
    const dialog = document.getElementById('dialog-guess');
    const titleEl = document.getElementById('dialog-guess-title');
    const descEl = document.getElementById('dialog-guess-desc');
    const textWrap = document.getElementById('dialog-guess-text-wrap');
    const selectWrap = document.getElementById('dialog-guess-select-wrap');
    const textInput = document.getElementById('dialog-guess-input');
    const selectInput = document.getElementById('dialog-guess-select');
    const cancelBtn = document.getElementById('dialog-guess-cancel');

    if (kind === 'mr_white') {
      titleEl.textContent = '🃏 Cơ hội lật kèo cho Mr. White!';
      descEl.textContent = 'Bạn vừa bị loại. Hãy nhập từ khóa của Dân Thường để cướp chiến thắng!';
      textWrap.hidden = false;
      selectWrap.hidden = true;
      textInput.value = '';
      textInput.required = true;
      cancelBtn.hidden = true;
    } else {
      titleEl.textContent = '🎯 Gián Điệp đoán Địa Điểm';
      descEl.textContent = 'Nếu đoán đúng bạn sẽ thắng ngay lập tức. Nếu sai, Phe Dân Thường thắng!';
      textWrap.hidden = true;
      selectWrap.hidden = false;
      textInput.required = false;
      cancelBtn.hidden = false;
      selectInput.innerHTML = '';
      SPYFALL_LOCATIONS.forEach((loc) => {
        const opt = document.createElement('option');
        opt.value = loc.name;
        opt.textContent = loc.name;
        selectInput.appendChild(opt);
      });
    }

    const form = document.getElementById('form-dialog-guess');
    cancelBtn.onclick = () => {
      dialog.returnValue = 'cancel';
      dialog.close();
    };

    form.onsubmit = (e) => {
      e.preventDefault();
      if (kind === 'mr_white') {
        const val = textInput.value.trim();
        if (!val) return;
        dialog.close('confirm');
        if (isHost) resolveMrWhiteGuess(val);
        else session.send('SPY_MRWHITE_GUESS', { guessText: val });
      } else {
        const loc = selectInput.value;
        dialog.close('confirm');
        if (isHost) {
          const me = state.players.find((p) => p.id === session.clientId);
          resolveSpyfallLocationGuess(me, loc);
        } else {
          session.send('SPY_LOCATION_GUESS', { location: loc });
        }
      }
    };

    if (!dialog.open) dialog.showModal();
  }

  function renderShareBox() {
    document.getElementById('spy-room-code').textContent = window.RoomNetwork.ROOM_LABEL;
    const shareUrl = window.RoomNetwork.buildShareUrl();
    document.getElementById('spy-share-url').textContent = shareUrl;
    window.AppUI.renderQrCode(document.getElementById('spy-qr'), shareUrl);
  }

  function buildSpyPlayerLabelEl(player, sizeClass = 'avatar-md', suffix = '') {
    const wrap = document.createElement('span');
    wrap.className = 'player-name-with-avatar';
    wrap.appendChild(window.AppUI.createAvatarEl(player?.avatarId, sizeClass));
    const txt = document.createElement('strong');
    txt.textContent = `${player?.name || '?'}${suffix}`;
    wrap.appendChild(txt);
    return wrap;
  }

  function runSpyScene() {
    if (!state) return;
    const key = `${state.phase}:${state.round}:${state.winner || ''}`;
    if (key === lastSceneKey) return;
    lastSceneKey = key;

    if (state.phase === 'PLAYING') {
      window.AudioEngine.stopNightAmbience();
      if (state.round === 1) {
        window.SceneFX.playPhase({
          mode: 'role',
          icon: '🕵️',
          kicker: 'CHIA BÀI BÍ MẬT',
          title: 'VÁN CHƠI BẮT ĐẦU',
          sub: 'Nhấn & giữ thẻ để xem từ khóa. Cả hội bắt đầu tranh luận!',
          duration: 2100
        });
      } else {
        window.SceneFX.playPhase({
          mode: 'day',
          icon: '🔄',
          kicker: `VÒNG THẨM VẤN ${state.round}`,
          title: `VÒNG ${state.round}`,
          sub: 'Thứ tự phát biểu đã được xáo lại — tiếp tục truy tìm Gián Điệp!',
          duration: 1450
        });
      }
    } else if (state.phase === 'GAME_OVER') {
      window.SceneFX.celebrate({ count: 110 });
      window.SceneFX.flash('rgba(251, 191, 36, 0.22)');
    } else if (state.phase === 'MR_WHITE_GUESS') {
      window.SceneFX.flash('rgba(168, 85, 247, 0.24)');
      window.SceneFX.shake();
    }
  }

  function renderPlayerVote() {
    const box = document.getElementById('spy-player-vote-box');
    const grid = document.getElementById('spy-my-vote-grid');
    const label = document.getElementById('spy-my-vote-label');
    const desc = document.getElementById('spy-player-vote-desc');
    if (!box || !grid || !state || !session) return;

    const show = !isHost && state.phase === 'PLAYING';
    box.hidden = !show;
    if (!show) return;

    const me = state.players.find((p) => p.id === session.clientId);
    const myVote = state.votes ? state.votes[session.clientId] : null;
    const votedTarget = myVote ? state.players.find((p) => p.id === myVote) : null;
    if (label) label.textContent = votedTarget ? `Đã vote: ${votedTarget.name}` : 'Chưa vote';

    grid.innerHTML = '';
    if (!me || !me.alive) {
      if (desc) desc.textContent = '💀 Bạn đã bị loại — hãy theo dõi phần còn lại của ván đấu.';
      return;
    }
    if (desc) {
      desc.textContent =
        'Chọn người bạn nghi là Gián Điệp. Quản Trò sẽ thấy phiếu này ngay trên màn hình chính — bạn có thể đổi phiếu bất cứ lúc nào.';
    }

    state.players
      .filter((p) => p.alive && p.id !== session.clientId)
      .forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `target-btn target-btn-avatar ${myVote === p.id ? 'selected' : ''}`;
        btn.appendChild(window.AppUI.createAvatarEl(p.avatarId, 'avatar-md'));
        const span = document.createElement('span');
        span.textContent = myVote === p.id ? `✓ ${p.name}` : p.name;
        btn.appendChild(span);
        btn.addEventListener('click', () => {
          session.send('SPY_VOTE', { targetId: p.id });
        });
        grid.appendChild(btn);
      });
  }

  function renderLiveVote() {
    const box = document.getElementById('spy-live-vote');
    const list = document.getElementById('spy-live-vote-list');
    const progress = document.getElementById('spy-live-vote-progress');
    if (!box || !list || !state) return;

    const groups = getVoteCounts();
    const entries = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    const total = entries.reduce((sum, [, voters]) => sum + voters.length, 0);
    const show = state.phase === 'PLAYING' && entries.length > 0;
    box.hidden = !show;
    if (!show) return;

    const max = Math.max(1, entries[0][1].length);
    if (progress) progress.textContent = `${total} phiếu từ điện thoại`;
    list.innerHTML = '';

    entries.forEach(([targetId, voters]) => {
      const target = state.players.find((p) => p.id === targetId);
      const li = document.createElement('li');
      li.className = 'vote-tally-item pop-in';

      const left = document.createElement('div');
      if (target) left.appendChild(buildSpyPlayerLabelEl(target, 'avatar-sm'));

      const bar = document.createElement('div');
      bar.className = 'vote-bar is-leading';
      const fill = document.createElement('span');
      fill.style.width = `${Math.max(8, Math.round((voters.length / max) * 100))}%`;
      bar.appendChild(fill);
      left.appendChild(bar);

      const count = document.createElement('span');
      count.className = 'pill pill-alive';
      count.textContent = `${voters.length} phiếu`;

      li.append(left, count);
      list.appendChild(li);
    });
  }

  function render() {
    if (!state || !session) return;
    runSpyScene();
    window.AppUI.setActiveGameMode(state.phase !== 'LOBBY', 'DAY');

    document.getElementById('spy-room-code').textContent = window.RoomNetwork.ROOM_LABEL;
    document.getElementById('spy-my-name').textContent = myName;
    const myAvSlot = document.getElementById('spy-my-avatar');
    if (myAvSlot) {
      myAvSlot.innerHTML = '';
      myAvSlot.appendChild(window.AppUI.createAvatarEl(myAvatarId, 'avatar-md'));
    }

    const lobbyEl = document.getElementById('spy-lobby');
    const gameEl = document.getElementById('spy-game');

    const resetLobbyBtn = document.getElementById('spy-host-reset-game');
    if (resetLobbyBtn && state.phase === 'LOBBY') resetLobbyBtn.hidden = true;

    if (state.phase === 'LOBBY') {
      lobbyEl.hidden = false;
      gameEl.hidden = true;
      renderLobby();
    } else {
      lobbyEl.hidden = true;
      gameEl.hidden = false;
      renderActiveGame();
    }
  }

  function renderLobby() {
    const count = state.players.length;
    const readyCount = state.players.filter((p) => p.ready).length;
    document.getElementById('spy-player-count').textContent = String(count);
    document.getElementById('spy-ready-summary').textContent = `${readyCount}/${count} sẵn sàng`;
    document.getElementById('spy-host-demo-wrap').hidden = !isHost;
    const playerLobbyControls = document.getElementById('spy-player-lobby-controls');
    const hostLobbyGuide = document.getElementById('spy-host-lobby-guide');
    if (playerLobbyControls) playerLobbyControls.hidden = isHost;
    if (hostLobbyGuide) hostLobbyGuide.hidden = !isHost;

    if (!isHost) {
      const me = state.players.find((p) => p.id === session.clientId);
      const readyBtn = document.getElementById('spy-ready-btn');
      if (me && me.ready) {
        readyBtn.textContent = '⏳ Đã Sẵn Sàng (Ấn để hủy)';
        readyBtn.className = 'btn btn-secondary btn-lg btn-block';
      } else {
        readyBtn.textContent = '✅ Ấn Sẵn Sàng';
        readyBtn.className = 'btn btn-success btn-lg btn-block';
      }
    }

    const listEl = document.getElementById('spy-player-list');
    listEl.innerHTML = '';
    if (count === 0) {
      const empty = document.createElement('li');
      empty.className = 'player-item';
      empty.textContent = 'Chưa có người chơi nào. Hãy quét mã QR bằng điện thoại để vào phòng!';
      listEl.appendChild(empty);
    } else {
      state.players.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'player-item pop-in';
        const suffix = p.id === session.clientId ? ' (Bạn)' : '';
        const left = buildSpyPlayerLabelEl(p, 'avatar-md', suffix);
        const pill = document.createElement('span');
        pill.className = `pill ${p.ready ? 'pill-ready' : 'pill-wait'}`;
        pill.textContent = p.ready ? 'Sẵn sàng' : 'Đang chờ';
        if (p.online === false && !p.isDemo) {
          li.classList.add('is-offline');
          const off = document.createElement('span');
          off.className = 'pill pill-dead pill-offline';
          off.textContent = '🔴 Mất kết nối';
          li.append(left, off, pill);
        } else {
          li.append(left, pill);
        }
        listEl.appendChild(li);
      });
    }

    const cfgForm = document.getElementById('spy-config-form');
    cfgForm.querySelectorAll('input[name="spyMode"]').forEach((r) => {
      r.checked = r.value === state.config.mode;
      r.disabled = !isHost;
    });

    const deckRow = document.getElementById('spy-deck-row');
    deckRow.hidden = state.config.mode !== 'undercover';
    const deckSel = document.getElementById('spy-deck-select');
    deckSel.value = state.config.deckKey || 'all';
    deckSel.disabled = !isHost;

    const countSel = document.getElementById('spy-count-select');
    countSel.value = String(state.config.spyCount);
    countSel.disabled = !isHost;

    const mrWhiteRow = document.getElementById('spy-mrwhite-row');
    mrWhiteRow.hidden = state.config.mode !== 'undercover';
    const mrWhiteCheck = document.getElementById('spy-mrwhite-check');
    mrWhiteCheck.checked = Boolean(state.config.mrWhite);
    mrWhiteCheck.disabled = !isHost;

    const startBtn = document.getElementById('spy-start-btn');
    startBtn.hidden = !isHost;
    startBtn.disabled = !(isHost && count >= 3 && readyCount === count);

    const hintEl = document.getElementById('spy-lobby-hint');
    if (count < 3) {
      hintEl.textContent = `Cần tối thiểu 3 người chơi (khuyên dùng 5–10 người). Hiện có ${count} người.`;
    } else if (readyCount < count) {
      hintEl.textContent = `Đang chờ ${count - readyCount} người ấn Sẵn sàng...`;
    } else {
      hintEl.textContent = isHost
        ? '🎉 Mọi người đã sẵn sàng! Ấn "Chia bài & Bắt đầu chơi"!'
        : '🎉 Tất cả đã sẵn sàng! Đang chờ chủ phòng bấm Bắt đầu...';
    }
  }

  function renderSecretCard() {
    const btn = document.getElementById('spy-toggle-card');
    const bgLayer = document.getElementById('spy-card-bg');
    btn.setAttribute('aria-expanded', String(cardRevealed));
    btn.classList.toggle('is-flipped', cardRevealed);

    const cardAv = document.getElementById('spy-card-avatar');
    if (cardAv) {
      cardAv.innerHTML = '';
      cardAv.appendChild(window.AppUI.createAvatarEl(myAvatarId, 'avatar-xl'));
    }
    const cardOwner = document.getElementById('spy-card-owner');
    if (cardOwner) {
      cardOwner.textContent = `${myName || 'Bạn'} — 👆 Nhấn & GIỮ để xem Thẻ Mật`;
    }

    if (!mySecret) return;
    const theme = SPY_CARD_THEMES[mySecret.role] || SPY_CARD_THEMES.civilian;
    if (bgLayer && theme.bgImage) {
      bgLayer.style.backgroundImage = `url('${theme.bgImage}')`;
    }
    if (theme.themeColor) {
      btn.style.setProperty('--role-theme', theme.themeColor);
    }

    const iconEl = document.getElementById('spy-card-icon');
    const titleEl = document.getElementById('spy-card-title');
    const detailEl = document.getElementById('spy-card-detail');
    const hintEl = document.getElementById('spy-card-hint');
    hintEl.hidden = true;

    if (state.config.mode === 'undercover') {
      if (mySecret.role === 'mr_white') {
        iconEl.textContent = '🃏';
        titleEl.textContent = 'BẠN LÀ MR. WHITE';
        detailEl.textContent = 'Thẻ trắng! Lắng nghe mọi người mô tả để đoán ra từ khóa Dân Thường.';
      } else {
        iconEl.textContent = '📝';
        titleEl.textContent = mySecret.word || '---';
        detailEl.textContent = 'Hãy mô tả từ khóa này thật khéo mà không làm lộ quá sớm!';
        if (mySecret.hint) {
          hintEl.hidden = false;
          hintEl.textContent = mySecret.hint;
        }
      }
    } else if (state.config.mode === 'twist') {
      iconEl.textContent = '❓';
      titleEl.textContent = 'CÂU HỎI BÍ MẬT CỦA BẠN';
      detailEl.textContent = mySecret.question || '---';
      hintEl.hidden = false;
      hintEl.textContent = 'Chỉ nói câu trả lời của bạn — KHÔNG đọc câu hỏi lên!';
    } else {
      if (mySecret.role === 'spy') {
        iconEl.textContent = '🕵️';
        titleEl.textContent = 'BẠN LÀ GIÁN ĐIỆP!';
        detailEl.textContent = 'Bạn không biết địa điểm. Hãy đặt câu hỏi và lắng nghe để đoán trúng địa điểm!';
      } else {
        iconEl.textContent = '📍';
        titleEl.textContent = mySecret.location || '---';
        detailEl.textContent = `Vai trò gợi ý của bạn: ${mySecret.locRole || 'Khách'}`;
      }
    }
  }

  function getVoteCounts() {
    const groups = {};
    Object.entries(state.votes || {}).forEach(([vId, targetId]) => {
      const voter = state.players.find((p) => p.id === vId);
      if (!voter || !voter.alive) return;
      if (!groups[targetId]) groups[targetId] = [];
      groups[targetId].push({ id: voter.id, name: voter.name, avatarId: voter.avatarId });
    });
    return groups;
  }

  function renderActiveGame() {
    const modeNames = {
      undercover: 'AI LÀ GIÁN ĐIỆP',
      twist: 'ĐIỆP VIÊN HỎI XOÁY',
      spyfall: 'SPYFALL — ĐOÁN ĐỊA ĐIỂM'
    };
    document.getElementById('spy-mode-badge').textContent = modeNames[state.config.mode] || 'GIÁN ĐIỆP';
    document.getElementById('spy-round-badge').textContent = `Vòng ${state.round}`;

    const deckBadge = document.getElementById('spy-deck-badge');
    if (state.config.mode === 'undercover') {
      deckBadge.hidden = false;
      deckBadge.textContent =
        state.config.deckKey === 'all'
          ? 'Trộn tất cả'
          : UNDERCOVER_DECKS[state.config.deckKey]?.label || 'Từ khóa';
    } else {
      deckBadge.hidden = true;
    }

    document.getElementById('spy-spark-note').textContent = state.roundSpark || 'Thảo luận tự do • Bầu chọn ngoài đời rồi ấn trên Laptop';

    const botBox = document.getElementById('spy-bot-announcer');
    const botTxt = document.getElementById('spy-bot-text');
    if (botBox) botBox.hidden = !isHost;
    if (botTxt && isHost) botTxt.textContent = state.botText || 'Bot đang dẫn dắt ván chơi...';

    const cliLine = document.getElementById('spy-cli-bot-line');
    const cliText = document.getElementById('spy-cli-bot-text');
    if (cliLine) cliLine.hidden = isHost;
    if (cliText) cliText.textContent = state.botText || 'Bot đang dẫn dắt ván chơi...';

    const remainingVotes = Math.max(0, (state.maxVotes || 1) - (state.votesUsed || 0));
    const remVotesEl = document.getElementById('spy-remaining-votes');
    const remBadEl = document.getElementById('spy-remaining-bad');
    if (remVotesEl) remVotesEl.textContent = `${remainingVotes} / ${state.maxVotes || 1} lượt`;
    if (remBadEl) {
      const badLeft =
        typeof state.aliveBadCount === 'number'
          ? state.aliveBadCount
          : state.players.filter((p) => p.alive && (p.role === 'spy' || p.role === 'mr_white')).length;
      remBadEl.textContent = `${badLeft} người`;
    }

    const cardPanel = document.getElementById('spy-player-card-panel');
    if (cardPanel) cardPanel.hidden = isHost;
    if (!isHost) {
      renderSecretCard();
    }

    const isSpyfall = state.config.mode === 'spyfall';
    const isTwist = state.config.mode === 'twist';

    document.getElementById('spy-spyfall-tools').hidden = !isSpyfall;
    document.getElementById('spy-twist-tools').hidden = !isTwist;
    document.getElementById('spy-order-box').hidden = isSpyfall;

    if (isTwist) {
      const revBanner = document.getElementById('spy-twist-revealed-banner');
      const revBtn = document.getElementById('spy-twist-reveal-btn');
      revBanner.hidden = !state.twistQuestionRevealed;
      if (state.twistQuestionRevealed) {
        document.getElementById('spy-twist-real-question').textContent = state.revealedQuestionText || '';
      }
      revBtn.hidden = !(isHost && state.phase === 'PLAYING' && !state.twistQuestionRevealed);
    }

    if (isSpyfall) {
      const meAlive = state.players.find((p) => p.id === session.clientId)?.alive;
      document.getElementById('spy-guess-location-wrap').hidden =
        !(state.phase === 'PLAYING' && meAlive && mySecret?.role === 'spy');

      const grid = document.getElementById('spy-locations-grid');
      grid.innerHTML = '';
      SPYFALL_LOCATIONS.forEach((loc) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `loc-chip ${crossedLocations.has(loc.name) ? 'crossed' : ''}`;
        chip.textContent = loc.name;
        chip.addEventListener('click', () => {
          if (crossedLocations.has(loc.name)) crossedLocations.delete(loc.name);
          else crossedLocations.add(loc.name);
          renderActiveGame();
        });
        grid.appendChild(chip);
      });

      const qList = document.getElementById('spy-spyfall-questions-list');
      if (qList.childElementCount === 0) {
        SPYFALL_QUESTIONS.forEach((q) => {
          const li = document.createElement('li');
          li.textContent = q;
          qList.appendChild(li);
        });
      }
    } else {
      const orderList = document.getElementById('spy-order-list');
      orderList.innerHTML = '';
      (state.turnOrder || []).forEach((id) => {
        const p = state.players.find((x) => x.id === id);
        if (p) {
          const li = document.createElement('li');
          li.appendChild(buildSpyPlayerLabelEl(p, 'avatar-md'));
          orderList.appendChild(li);
        }
      });
    }

    // Laptop Host Verdict Selection (IRL Vote) / Phone Live Status
    const voteHeading = document.getElementById('spy-vote-heading');
    const voteInst = document.getElementById('spy-vote-instruction');
    if (voteHeading) {
      voteHeading.textContent = isHost
        ? '⚖️ Phán quyết ngoài đời — Chọn người bị Vote'
        : '📋 Danh sách người chơi trong ván';
    }
    if (voteInst) {
      voteInst.textContent = isHost
        ? 'Cả hội tranh luận và biểu quyết ngoài đời xong, đại diện bấm chọn người bị nghi là Gián Điệp bên dưới:'
        : 'Tranh luận ngoài đời tự do! Khi thống nhất xong, chọn người bị vote trên màn hình Laptop Quản Trò.';
    }

    const voteList = document.getElementById('spy-vote-list');
    voteList.innerHTML = '';

    state.players.forEach((p) => {
      const li = document.createElement('li');
      const offline = p.online === false && !p.isDemo;
      li.className = `vote-row pop-in ${p.alive ? '' : 'eliminated'} ${offline ? 'is-offline' : ''}`;

      const info = document.createElement('div');
      info.appendChild(buildSpyPlayerLabelEl(p, 'avatar-md', p.id === session.clientId ? ' (Bạn)' : ''));
      if (offline) {
        const off = document.createElement('span');
        off.className = 'pill pill-dead pill-offline';
        off.textContent = '🔴 Mất kết nối';
        info.appendChild(off);
      }

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '0.5rem';
      actions.style.alignItems = 'center';

      if (!p.alive) {
        const revPill = document.createElement('span');
        revPill.className = 'pill pill-dead';
        const r = p.revealedRole || p.role;
        revPill.textContent =
          r === 'spy' ? '🕵️ Gián Điệp' : r === 'mr_white' ? '🃏 Mr. White' : '🧑‍🌾 Dân Thường';
        actions.appendChild(revPill);
      } else if (isHost && state.phase === 'PLAYING') {
        const elimBtn = document.createElement('button');
        elimBtn.type = 'button';
        elimBtn.className = 'btn btn-danger btn-sm';
        elimBtn.textContent = '⚖️ Chọn loại (Đã vote)';
        elimBtn.addEventListener('click', async () => {
          const ok = await window.AppUI.confirmDialog(
            'Chốt kết quả vote ngoài đời?',
            `Xác nhận cả hội đã vote loại ${p.name}?`
          );
          if (ok) eliminatePlayer(p.id);
        });
        actions.appendChild(elimBtn);
      } else {
        const alivePill = document.createElement('span');
        alivePill.className = 'pill pill-alive';
        alivePill.textContent = 'Còn sống';
        actions.appendChild(alivePill);
      }

      li.append(info, actions);
      voteList.appendChild(li);
    });

    renderPlayerVote();
    renderLiveVote();

    const aliveCount = state.players.filter((p) => p.alive).length;
    document.getElementById('spy-vote-progress').textContent =
      state.phase === 'PLAYING' ? `Vòng ${state.round} • ${aliveCount} người còn lại` : 'Đã kết thúc';

    document.getElementById('spy-host-controls').hidden = !(isHost && state.phase === 'PLAYING');
    const resetGameBtn = document.getElementById('spy-host-reset-game');
    if (resetGameBtn) resetGameBtn.hidden = !isHost;
    document.getElementById('spy-mrwhite-banner').hidden = state.phase !== 'MR_WHITE_GUESS';
    const hostMrWhiteForm = document.getElementById('spy-host-mrwhite-form');
    if (hostMrWhiteForm) hostMrWhiteForm.hidden = !(isHost && state.phase === 'MR_WHITE_GUESS');

    const overBox = document.getElementById('spy-gameover-box');
    overBox.hidden = state.phase !== 'GAME_OVER';
    if (state.phase === 'GAME_OVER') {
      const wMap = {
        civilian: '🏆 PHE DÂN THƯỜNG CHIẾN THẮNG!',
        spy: '🕵️ PHE GIÁN ĐIỆP CHIẾN THẮNG!',
        mr_white: '🃏 MR. WHITE LẬT KÈO CHIẾN THẮNG!'
      };
      document.getElementById('spy-winner-banner').textContent = wMap[state.winner] || 'KẾT THÚC!';
      const ans = state.answerSummary || {};
      const ansEl = document.getElementById('spy-answer-reveal');
      if (state.config.mode === 'undercover') {
        ansEl.innerHTML = `<p>${escapeHtml(state.winReason)}</p><p><strong>Từ Dân Thường:</strong> ${escapeHtml(
          ans.civilianWord
        )} • <strong>Từ Gián Điệp:</strong> ${escapeHtml(ans.spyWord)}</p>`;
      } else if (state.config.mode === 'twist') {
        ansEl.innerHTML = `<p>${escapeHtml(state.winReason)}</p><p><strong>Câu hỏi Dân Thường:</strong> ${escapeHtml(
          ans.civilianWord
        )}</p><p><strong>Câu hỏi Gián Điệp:</strong> ${escapeHtml(ans.spyWord)}</p>`;
      } else {
        ansEl.innerHTML = `<p>${escapeHtml(state.winReason)}</p><p><strong>Địa điểm bí mật:</strong> ${escapeHtml(
          ans.location
        )}</p>`;
      }

      const revList = document.getElementById('spy-reveal-list');
      revList.innerHTML = '';
      state.players.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'reveal-item pop-in';
        const left = buildSpyPlayerLabelEl(p, 'avatar-md');
        const right = document.createElement('span');
        right.className = 'reveal-role';
        const theme = SPY_CARD_THEMES[p.role] || SPY_CARD_THEMES.civilian;
        const art = document.createElement('span');
        art.className = 'reveal-role-art';
        art.setAttribute('aria-hidden', 'true');
        if (theme.bgImage) art.style.backgroundImage = `url('${theme.bgImage}')`;
        const roleLabel =
          p.role === 'spy' ? '🕵️ Gián Điệp' : p.role === 'mr_white' ? '🃏 Mr. White' : '🧑‍🌾 Dân Thường';
        right.append(
          art,
          document.createTextNode(`${roleLabel}${p.word ? ` (${p.word})` : p.locRole ? ` (${p.locRole})` : ''}`)
        );
        li.append(left, right);
        revList.appendChild(li);
      });

      document.getElementById('spy-play-again').hidden = !isHost;
    }
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
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
