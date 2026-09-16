// ============================================================
//  engine.js
//
//  受講者はこのファイルを編集しない。開く必要もない。
//
//  ------------------------------------------------------------
//  game.js に公開しているもの
//
//    BOARD_W          盤の幅   300
//    BOARD_H          盤の高さ 400
//    tilt.x           左右の傾き  -1 〜 1（右に倒すと +）
//    tilt.y           前後の傾き  -1 〜 1（手前に倒すと +）
//    drawBall(x, y)             玉を描く
//    drawWall(x, y, w, h)       壁を描く（左上が x, y）
//    drawGoal(x, y, r)          ゴールの穴を描く
//
//  game.js 側で function update() を定義すると、engine が毎フレーム呼ぶ。
//
//  ------------------------------------------------------------
//  index.html に期待している要素
//
//    #board      必須。ここに描画する
//    #ball       任意。あれば非表示にする（勉強会(1)で作ったCSSの玉）
//    #startBtn   任意。あればセンサー開始ボタンとして使う
//
//  #timer には触らない。勉強会(3)で受講者が JavaScript から書き換える。
//
//  ------------------------------------------------------------
//  読み込み順（index.html）
//
//    <script src="three.min.js"></script>
//    <script src="engine.js"></script>
//    <script src="game.js"></script>
//
// ============================================================

(function () {
  "use strict";

  // ---- 受講者に見せる盤の座標系 ----
  // 左上が (0, 0)、右下が (BOARD_W, BOARD_H)。y は下向きが正。
  var BOARD_W = 300;
  var BOARD_H = 400;

  // ---- 3D空間での盤の大きさ ----
  var WORLD_W = 6;
  var WORLD_H = 8;
  var SCALE = WORLD_W / BOARD_W;   // 0.02
  var BALL_R = 0.2;

  var tilt = { x: 0, y: 0 };

  var running = false;
  var stopped = false;


  // ============================================================
  //  エラー表示
  //
  //  受講者が自力で原因にたどり着けることを優先し、
  //  例外の生メッセージに日本語の補足を付けて画面に出す。
  // ============================================================

  var errorBox = null;

  function showError(title, detail) {
    if (!errorBox) {
      errorBox = document.createElement("div");
      errorBox.style.cssText = [
        "position:fixed", "left:0", "right:0", "bottom:0",
        "background:#3a1414", "color:#ffd7d7",
        "font:13px/1.7 monospace", "padding:14px 16px",
        "border-top:2px solid #a33", "white-space:pre-wrap",
        "text-align:left", "z-index:9999", "max-height:45vh", "overflow:auto"
      ].join(";");
      document.body.appendChild(errorBox);
    }
    errorBox.textContent = detail ? title + "\n\n" + detail : title;
  }

  // 例外の内容から、初学者がつまずきやすい原因を推測して補足する。
  function explain(err) {
    var msg = String(err && err.message ? err.message : err);

    if (/is not defined/.test(msg)) {
      var name = (msg.match(/(\w+) is not defined/) || [])[1] || "";
      return name + " という名前が見つかりません。\n" +
             "・つづりが違っていないか\n" +
             "・let で作る前に使っていないか\n" +
             "・update() の外で作った変数を中で使おうとしていないか";
    }
    if (/Cannot read propert(y|ies).*of undefined/.test(msg)) {
      return "存在しないものの中身を読もうとしています。\n" +
             "・ball など、オブジェクトを作る行を書いたか\n" +
             "・つづりが合っているか";
    }
    if (/is not a function/.test(msg)) {
      return "関数として呼び出せないものを呼んでいます。\n" +
             "・関数名のつづりを確認する（drawBall など）";
    }
    if (/Unexpected|Invalid or unexpected/.test(msg)) {
      return "文法のエラーです。\n" +
             "・{ } や ( ) の対応が取れているか\n" +
             "・行末の ; を忘れていないか";
    }
    return "";
  }

  // game.js の読み込み時（文法エラーなど）に発生する例外も拾う。
  window.addEventListener("error", function (e) {
    if (stopped) return;
    stopped = true;
    showError("エラーが発生しました: " + e.message,
              explain(e.error || e.message) +
              "\n\n" + (e.filename || "").split("/").pop() + " の " + e.lineno + "行目付近");
  });


  // ============================================================
  //  センサー
  // ============================================================

  // ------------------------------------------------------------
  //  傾きの求め方
  //
  //  beta / gamma をそのまま使ってはいけない。
  //  gamma は定義上 [-90, 90] に制限されており、端末が立ってくる
  //  （beta が 90 に近づく）と Z-X'-Y'' 分解が縮退して、
  //  わずかな傾きで gamma が -90 と 90 の間を飛ぶ。
  //  ゲーム中は端末を見やすい角度（beta 40〜60°）で持つので、
  //  この特異点のすぐ近くにいることになる。
  //
  //  そこで角度そのものではなく、
  //  「重力を画面平面に投影したベクトル」を使う。
  //  x 成分に cos(beta) が掛かるため、beta が 90 に近づくと
  //  自動的に 0 へ潰れ、gamma の飛びが打ち消される。
  //  しかも坂を転がる向きそのものなので、物理的にも正しい。
  // ------------------------------------------------------------

  var DEG  = Math.PI / 180;
  var GAIN = 2.5;        // 約24°傾けると最大(1.0)になる
  var SIGN_X = 1;        // 左右の向きが合わない端末では -1 にする
  var SIGN_Y = 1;        // 前後の向きが合わない端末では -1 にする

  var baseX = null, baseY = null;   // 開始時の姿勢を基準にする

  var sensorRequested = false;   // 開始ボタンが押されたか
  var gotSensorValue = false;    // 実際に値が1回でも届いたか
  var sawNullValue = false;      // イベントは来たが beta/gamma が null だったか

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // 重力を画面平面に投影した成分（それぞれ -1 〜 1）
  function gravityOnScreen(beta, gamma) {
    var b = beta * DEG, g = gamma * DEG;
    return { x: Math.cos(b) * Math.sin(g), y: Math.sin(b) };
  }

  function onOrientation(e) {
    if (e.beta === null || e.gamma === null) { sawNullValue = true; return; }
    gotSensorValue = true;

    var v = gravityOnScreen(e.beta, e.gamma);
    if (baseX === null) { baseX = v.x; baseY = v.y; }

    tilt.x = clamp(SIGN_X * (v.x - baseX) * GAIN, -1, 1);
    tilt.y = clamp(SIGN_Y * (v.y - baseY) * GAIN, -1, 1);
  }

  function attachOrientation() {
    window.addEventListener("deviceorientation", onOrientation);

    // 一部の Android では deviceorientation が発火せず、
    // deviceorientationabsolute の側だけが届くことがある。
    // 両方購読しても、先に来た方が使われるだけで害はない。
    window.addEventListener("deviceorientationabsolute", onOrientation);

    // 値が届かないまま黙って動かないのが一番たちが悪いので、
    // 数秒待って何も来ていなければ状況を画面に出す。
    setTimeout(function () {
      if (gotSensorValue) return;
      if (sawNullValue) {
        showError("センサーは動いていますが、値が取得できていません。",
                  "端末やブラウザがモーションセンサーへのアクセスを\n" +
                  "制限している可能性があります。\n" +
                  "矢印キーでも操作できます。");
      } else {
        showError("センサーの値が届いていません。",
                  "次を確認してください。\n" +
                  "・https:// で開いているか（http:// や file:// では動きません）\n" +
                  "・Android Chrome の場合、サイトの設定でモーションセンサーが\n" +
                  "  ブロックされていないか\n" +
                  "・PCで開いている場合、センサーは無いのが正常です（矢印キーで操作）");
      }
    }, 2500);
  }

  function enableSensors() {
    sensorRequested = true;
    var DOE = window.DeviceOrientationEvent;

    if (!DOE) {
      showError("この環境にはセンサーがありません。",
                "矢印キーで操作できます。");
      return;
    }

    // iOS 13以降は、ユーザー操作の中で許可を求める必要がある
    if (typeof DOE.requestPermission === "function") {
      DOE.requestPermission().then(function (res) {
        if (res === "granted") {
          attachOrientation();
        } else {
          showError("センサーの使用が許可されませんでした。",
                    "Safariの設定からこのサイトのデータを消すか、\n" +
                    "プライベートブラウズで開き直すと再度確認できます。\n" +
                    "矢印キーでも操作できます。");
        }
      }).catch(function () {
        showError("センサーを開始できませんでした。",
                  "https:// で開いているか確認してください。\n" +
                  "矢印キーでも操作できます。");
      });
    } else {
      // Android Chrome など。許可を求める仕組みが無く、そのまま購読できる
      attachOrientation();
    }
  }

  // ---- PC用（矢印キー） ----
  var keys = {};
  window.addEventListener("keydown", function (e) {
    if (e.key.indexOf("Arrow") === 0) { keys[e.key] = true; e.preventDefault(); }
  });
  window.addEventListener("keyup", function (e) { keys[e.key] = false; });

  function readKeys() {
    var kx = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
    var ky = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
    if (kx || ky) { tilt.x = kx; tilt.y = ky; }
    else if (baseX === null) { tilt.x = 0; tilt.y = 0; }
  }


  // ============================================================
  //  3D描画
  // ============================================================

  var scene, camera, renderer, boardGroup;
  var ballPool = [], wallPool = [], goalPool = [];
  var ballUsed = 0, wallUsed = 0, goalUsed = 0;

  // 盤座標 → 3D座標
  function wx(x) { return (x - BOARD_W / 2) * SCALE; }
  function wz(y) { return (y - BOARD_H / 2) * SCALE; }

  function setupScene(host) {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101014);

    var w = host.clientWidth  || 300;
    var h = host.clientHeight || 400;

    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    fitCamera(w, h);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a2018, 0.6));
    var dir = new THREE.DirectionalLight(0xffffff, 0.95);
    dir.position.set(4, 10, 6);
    scene.add(dir);

    boardGroup = new THREE.Group();
    scene.add(boardGroup);

    // 盤
    var deck = new THREE.Mesh(
      new THREE.BoxGeometry(WORLD_W, 0.3, WORLD_H),
      new THREE.MeshStandardMaterial({ color: 0x8a6240, roughness: 0.85 })
    );
    deck.position.y = -0.15 - BALL_R;
    boardGroup.add(deck);

    // 外周の縁（見た目のみ。当たり判定は game.js 側で受講者が書く）
    var rimMat = new THREE.MeshStandardMaterial({ color: 0x6d4a2f, roughness: 0.8 });
    var t = 0.18, rh = 0.5;
    [[0, -WORLD_H / 2, WORLD_W + t * 2, t],
     [0,  WORLD_H / 2, WORLD_W + t * 2, t],
     [-WORLD_W / 2, 0, t, WORLD_H],
     [ WORLD_W / 2, 0, t, WORLD_H]].forEach(function (r) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(r[2], rh, r[3]), rimMat);
      m.position.set(r[0], rh / 2 - BALL_R, r[1]);
      boardGroup.add(m);
    });

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    host.appendChild(renderer.domElement);
  }

  // 盤が切れずに収まる距離までカメラを引く
  function fitCamera(w, h) {
    var vFov = camera.fov * Math.PI / 180;
    var byH = (WORLD_H / 2) / Math.tan(vFov / 2);
    var byW = (WORLD_W / 2) / Math.tan(vFov / 2) / (w / h);
    camera.position.set(0, Math.max(byH, byW) * 1.06, 0.001);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function onResize() {
    var host = document.getElementById("board");
    if (!host || !renderer) return;
    var w = host.clientWidth || 300;
    var h = host.clientHeight || 400;
    fitCamera(w, h);
    camera.lookAt(0, 0, 0);
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);


  // ---- プール（毎フレーム使い回す） ----
  // 呼ばれた回数だけ表示し、余りは隠す。
  // これで「玉を複数描く」も受講者側の変更だけで成立する。

  function takeBall() {
    if (ballPool.length <= ballUsed) {
      // metalness を上げると環境マップが無い状態では真っ黒になるため、
      // 環境マップ無しでも成立する値にしている（教材として壊れにくさを優先）
      var m = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_R, 24, 16),
        new THREE.MeshStandardMaterial({ color: 0xe6e9f0, metalness: 0.25, roughness: 0.3 })
      );
      boardGroup.add(m);
      ballPool.push(m);
    }
    return ballPool[ballUsed++];
  }

  function drawBall(x, y) {
    if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) {
      throw new Error("drawBall には数値を2つ渡してください（受け取った値: " + x + ", " + y + "）");
    }
    var m = takeBall();
    m.visible = true;
    m.position.set(wx(x), 0, wz(y));
  }

  function drawWall(x, y, w, h) {
    if (wallPool.length <= wallUsed) {
      // 高さは外周の縁（0.5）より低くしておく。
      // 同じ高さだと、盤のふちまで伸ばした壁の上面と縁の上面が
      // 同一平面になり、描画がちらつく（z-fighting）。
      var m = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.44, 1),
        new THREE.MeshStandardMaterial({ color: 0x5d3f26, roughness: 0.8 })
      );
      boardGroup.add(m);
      wallPool.push(m);
    }
    var mesh = wallPool[wallUsed++];
    mesh.visible = true;
    mesh.scale.set(Math.max(w * SCALE, 0.01), 1, Math.max(h * SCALE, 0.01));
    mesh.position.set(wx(x + w / 2), 0.22 - BALL_R, wz(y + h / 2));
  }

  function drawGoal(x, y, r) {
    if (goalPool.length <= goalUsed) {
      var m = new THREE.Mesh(
        new THREE.CircleGeometry(1, 28),
        new THREE.MeshBasicMaterial({ color: 0x121212 })
      );
      m.rotation.x = -Math.PI / 2;
      boardGroup.add(m);
      goalPool.push(m);
    }
    var mesh = goalPool[goalUsed++];
    mesh.visible = true;
    mesh.scale.setScalar(Math.max(r * SCALE, 0.01));
    mesh.position.set(wx(x), -BALL_R + 0.005, wz(y));
  }

  function hideUnused(pool, used) {
    for (var i = used; i < pool.length; i++) pool[i].visible = false;
  }


  // ============================================================
  //  メインループ
  // ============================================================

  function loop() {
    if (stopped) return;
    requestAnimationFrame(loop);

    readKeys();

    ballUsed = wallUsed = goalUsed = 0;

    if (typeof window.update === "function") {
      try {
        window.update();
      } catch (err) {
        stopped = true;
        showError("update() の中でエラーが発生しました: " + err.message, explain(err));
        return;
      }
    }

    hideUnused(ballPool, ballUsed);
    hideUnused(wallPool, wallUsed);
    hideUnused(goalPool, goalUsed);

    // 盤を傾けて見せる（見た目だけ。物理は game.js 側）
    boardGroup.rotation.z = -tilt.x * 0.12;
    boardGroup.rotation.x =  tilt.y * 0.12;

    renderer.render(scene, camera);
  }


  // ============================================================
  //  起動
  // ============================================================

  function start() {
    // game.js の文法エラーなどを既に報告済みなら、
    // その内容を「update() が見つかりません」で上書きしない。
    // 文法エラー時は update() が定義されないため、後段の検査が誤った案内をしてしまう。
    if (stopped) return;

    if (typeof THREE === "undefined") {
      showError("Three.js が読み込まれていません。",
                "index.html の script タグの順番を確認してください。\n" +
                "three.min.js → engine.js → game.js の順である必要があります。");
      return;
    }

    var host = document.getElementById("board");
    if (!host) {
      showError('id="board" の要素が見つかりません。',
                'index.html に <div id="board"></div> があるか、\n' +
                "つづりが board になっているか確認してください。");
      return;
    }

    // 勉強会(1)でCSSで置いた玉は、ここから engine が描くので隠す
    var cssBall = document.getElementById("ball");
    if (cssBall) cssBall.style.display = "none";

    setupScene(host);

    var btn = document.getElementById("startBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        enableSensors();
        btn.blur();          // 以降の矢印キーがボタンに吸われないようにする
      });
    }

    if (typeof window.update !== "function") {
      showError("update() が見つかりません。",
                "game.js に次の形の関数を書いてください。\n\n" +
                "    function update() {\n" +
                "      // ここに毎フレームやることを書く\n" +
                "    }\n\n" +
                "index.html で game.js を読み込んでいるかも確認してください。");
      // ループ自体は回す。update() を書いた時点で動き出す。
    }

    running = true;
    loop();
  }

  // ---- game.js より先に評価されるので、読み込み完了を待ってから起動する ----
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }


  // ---- 公開 ----
  window.BOARD_W = BOARD_W;
  window.BOARD_H = BOARD_H;
  window.tilt = tilt;
  window.drawBall = drawBall;
  window.drawWall = drawWall;
  window.drawGoal = drawGoal;
})();
