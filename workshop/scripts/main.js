/* ============================================================================
 * 无名杀 · DIY 工坊 —— 交互脚本
 * 职责：入场编排、表单→卡面同步、立绘上传与裁剪、导出 350×464 头像。
 * 无依赖、不联网、不改文件；图片只在本地内存与 canvas 里处理。
 * ==========================================================================*/

(function () {
	"use strict";

	/* ── 常量 ──────────────────────────────────────────────────────────── */
	var GROUP_GLYPH = {
		wei: "魏",
		shu: "蜀",
		wu: "吴",
		qun: "群",
		jin: "晋",
		shen: "神",
	};

	/* 头像规格：与官方 image/character/*.jpg 一致 */
	var AVATAR_W = 350;
	var AVATAR_H = 464;

	/* 技能音频：一个技能最多几个文件、单个多大、总体多大。
	 * 音频最终会跟着扩展一起分发，所以不能放任几十 MB 进来 ——
	 * 一首 mp3 三四十秒通常 300KB~1MB，5MB 足够宽松。 */
	var AUDIO_MAX_COUNT = 6;                          /* 每个技能最多几个 */
	var AUDIO_MAX_BYTES = 5 * 1024 * 1024;            /* 单个文件上限 */
	var AUDIO_MAX_MB = Math.round(AUDIO_MAX_BYTES / 1024 / 1024);
	var AUDIO_LONG_SECONDS = 60;                      /* 超过这个时长就提示一句（不拦） */

	/* 缩放上限（相对 cover 基准） */
	var MAX_ZOOM = 4;

	/* 自动构图时垂直方向的偏好：0 = 顶部对齐，1 = 底部对齐。
	 * 武将立绘的人物通常在上半部，取偏顶部的构图能保住头部。 */
	var AUTO_VERTICAL_BIAS = 0.14;

	/* ── 小工具 ────────────────────────────────────────────────────────── */
	function $(id) {
		return document.getElementById(id);
	}

	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, value));
	}

	/* ── 体力写法 ─────────────────────────────────────────────────────────
	 * 表单里写 `4/6/2` —— 依次是体力、体力上限、护甲。这是游戏本身支持的写法
	 * （见 references/无名杀武将指南.md 2.3），所以原样交给 AI 就能用；
	 * 只写一个数时，体力与上限相同、护甲 0。
	 *
	 * 全角数字、全角斜杠、其他杂字符都在这里一并规整 —— 用户不该因为
	 * 输入法状态不对就被卡住。 */
	function sanitizeHpInput(raw) {
		return String(raw == null ? "" : raw)
			.replace(/[０-９]/g, function (ch) {
				return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
			})
			.replace(/／/g, "/")
			.replace(/[^\d/]/g, ""); /* 只收数字与斜杠 */
	}

	/* 交给 AI 用：清掉杂字符，并把重复/首尾斜杠收干净 */
	function normalizeHpText(raw) {
		return sanitizeHpInput(raw)
			.replace(/\/{2,}/g, "/")
			.replace(/^\/+|\/+$/g, "");
	}

	/* 解析成 { current, max, armor }；认不出数字时按 0 处理。
	 * 卡面按**上限**画勾玉（跟游戏里的武将牌一致）。 */
	function parseHpText(raw) {
		var parts = normalizeHpText(raw).split("/");
		var current = parseInt(parts[0], 10);
		var max = parseInt(parts[1], 10);
		var armor = parseInt(parts[2], 10);
		if (!(current > 0)) current = max > 0 ? max : 0;
		if (!(max > 0)) max = current;
		if (!(armor >= 0)) armor = 0;
		return { current: current, max: max, armor: armor };
	}

	/* 填回表单 / 提交用：补成整齐的三段 `体力/上限/护甲`
	 * （`4` → `4/4/0`，`4/6` → `4/6/0`，多出来的段截掉）。
	 * 体力大于上限时把**上限抬到体力** —— 引擎开局 `$update()` 会把超上限的体力
	 * 压回上限（引擎 `$update()`），不抬的话用户填的 6 血会变成 4 血。 */
	function hpFieldText(raw) {
		var parts = normalizeHpText(raw)
			.split("/")
			.filter(function (s) {
				return s !== "";
			});
		if (!parts.length) return "4/4/0";
		if (parts.length === 1) parts.push(parts[0]);
		while (parts.length < 3) parts.push("0");
		parts = parts.slice(0, 3);

		var cur = parseInt(parts[0], 10);
		var max = parseInt(parts[1], 10);
		if (cur > 0 && max > 0 && cur > max) parts[1] = parts[0];

		return parts.join("/");
	}

	function fieldValue(id) {
		var el = $(id);
		return el ? el.value.trim() : "";
	}

	function setText(id, text, fallback) {
		var el = $(id);
		if (!el) return;
		el.textContent = text || fallback || "";
	}

	/* ── 入场序列：一次性错峰揭示（时长与缓动交给 CSS） ────────────────── */
	function playEntrance() {
		var items = document.querySelectorAll(".reveal");
		requestAnimationFrame(function () {
			items.forEach(function (el) {
				el.classList.add("is-in");
			});
		});
	}

	/* ── 卡面同步 ──────────────────────────────────────────────────────── */
	var card = $("hero-card");

	/* 体力显示：10 点以内画勾玉；超过 10 点卡面横向排不下，
	 * 改为「一个勾玉 + ×N」，避免挤成一团或者溢出卡面。 */
	var PIP_LIMIT = 10;

	function renderPips(count, host) {
		if (!host) return;
		var hp = clamp(Number(count) || 0, 0, 999);
		host.textContent = "";

		if (hp <= PIP_LIMIT) {
			for (var i = 0; i < hp; i++) {
				var pip = document.createElement("span");
				pip.className = "pip";
				host.appendChild(pip);
			}
		} else {
			var dot = document.createElement("span");
			dot.className = "pip";
			var num = document.createElement("span");
			num.className = "pip-count";
			num.textContent = "×" + hp;
			host.appendChild(dot);
			host.appendChild(num);
		}

		host.setAttribute("aria-label", "体力上限 " + hp);
	}

	function renderCard() {
		var name = fieldValue("f-name");
		var title = fieldValue("f-title");
		var hp = parseHpText(fieldValue("f-hp")).max;
		var skills = getSkills();

		setText("card-name", name, "灰猫");
		setText("card-title", title, "混世喵王");
		renderPips(hp, $("card-pips"));
		renderCardSkills(skills);

		var hasNamedSkill = skills.some(function (s) {
			return s.name;
		});
		card.classList.toggle("is-incomplete", !name || !hasNamedSkill);
	}

	/* 卡面技能区：把表单里的技能逐条铺到卡面底部。
	 * 表单留空时卡面显示示例内容 —— 输入框里是 placeholder，
	 * 但卡面总得有东西可看，否则一片空白不知道能填什么。 */
	function renderCardSkills(skills) {
		var host = $("card-skills");
		if (!host) return;
		host.textContent = "";
		/* 超过 4 条时收字号，避免技能把立绘挤没 */
		host.classList.toggle("is-crowded", skills.length > 4);

		skills.forEach(function (skill) {
			var wrap = document.createElement("div");
			wrap.className = "hero-card__skill";

			var nameEl = document.createElement("span");
			nameEl.className = "hero-card__skill-name";
			nameEl.textContent = skill.name || "未命名技能";

			var descEl = document.createElement("p");
			descEl.className = "hero-card__skill-desc";
			descEl.textContent = skill.desc || "尚未填写技能描述。";

			wrap.appendChild(nameEl);
			wrap.appendChild(descEl);
			host.appendChild(wrap);
		});
	}

	function renderGroup(value) {
		var key = GROUP_GLYPH[value] ? value : "wei";
		setText("card-group", GROUP_GLYPH[key]);
		card.setAttribute("data-group", key);
	}

	/* ── 技能列表 ────────────────────────────────────────────────────────
	 * 一个武将可以带任意多个技能。表单里每个技能是一张可单独删除的小卡，
	 * 卡面同步铺出全部技能；序号用中文数字，呼应工坊的典籍气质。 */
	var skillList = $("skill-list");

	var CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

	/* 给每张技能卡发一个**终身不变**的号。第四步（台词/配音）靠它对齐。
	 * 不能用列表下标：删掉中间第二个技能后，第三个技能顶到下标 1，
	 * 台词整套跟着串一个位置 —— 而且**不报任何错**，玩家只觉得"台词乱了"。 */
	var skillSeq = 0;

	function skillLabel(index) {
		return "技能" + (CN_NUM[index] || String(index + 1));
	}

	/* 造一张技能卡。刻意用 DOM API 而不是 innerHTML —— 技能描述里常带
	 * 【杀】这样的中文方括号，用字符串拼 HTML 会把用户输入当标签解析。
	 *
	 * 结构：可点击的头部（序号 + 技能名摘要 + 展开/收起 + 删除）+ 可折叠正文。
	 * 头部用 div[role=button] 而不是 <button>：删除键是它内部的按钮，
	 * HTML 不允许按钮嵌套按钮。 */
	function makeSkillItem(name, desc) {
		var item = document.createElement("div");
		item.className = "skill-item";
		item.setAttribute("data-open", "true");
		item._key = "skill-" + ++skillSeq;
		/* 「示例位」的标记由 addSkill 打 —— 只有它知道这一张是不是示例位。
		 * 留空时卡面显示示例内容；用户自己新加的技能留空则显示「未命名技能」，
		 * 否则加两张空技能，卡面上会出现两个一模一样的「未命名技能」。 */

		var head = document.createElement("div");
		head.className = "skill-item__head";
		head.setAttribute("role", "button");
		head.setAttribute("tabindex", "0");
		head.setAttribute("aria-expanded", "true");

		var label = document.createElement("span");
		label.className = "skill-item__index";

		var preview = document.createElement("span");
		preview.className = "skill-item__preview";
		preview.textContent = name || skillNameFallback(item);

		var toggle = document.createElement("span");
		toggle.className = "skill-item__toggle";
		toggle.textContent = "收起";

		var remove = document.createElement("button");
		remove.type = "button";
		remove.className = "skill-item__remove";
		remove.textContent = "×";
		remove.setAttribute("aria-label", "删除这个技能");
		remove.addEventListener("click", function (event) {
			event.stopPropagation(); /* 删除不该顺带把卡片折叠了 */
			item.remove();
			/* 第四步要跟着少一块；台词与配音按 `_key` 留下，不会被邻居顶替 */
			renderMoreSkills();
			refreshSkills();
		});

		head.appendChild(label);
		head.appendChild(preview);
		head.appendChild(toggle);
		head.appendChild(remove);

		head.addEventListener("click", function () {
			setSkillOpen(item, item.getAttribute("data-open") !== "true");
		});
		head.addEventListener("keydown", function (event) {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				setSkillOpen(item, item.getAttribute("data-open") !== "true");
			}
		});

		var body = document.createElement("div");
		body.className = "skill-item__body";

		var nameInput = document.createElement("input");
		nameInput.className = "field__input";
		nameInput.type = "text";
		nameInput.maxLength = 10;
		nameInput.placeholder = "技能名";
		nameInput.value = name || "";
		nameInput.setAttribute("aria-label", "技能名");
		item._nameEl = nameInput;
		nameInput.addEventListener("input", function () {
			/* 折叠后头部那行就是唯一线索，必须跟着输入实时更新 */
			preview.textContent = nameInput.value.trim() || skillNameFallback(item);
			refreshSkills();
		});

		var descInput = document.createElement("textarea");
		descInput.className = "field__input field__input--area field__input--skill-desc";
		/* 2 行而不是 3 行：展开卡每张因此矮 22px，两张默认展开卡
		 * 才装得进更矮的技能列表方框（见 components.css .skill-list）。 */
		descInput.rows = 2;
		descInput.placeholder = "技能描述：仅描述，效果请在「更多拓展」填写";
		descInput.value = desc || "";
		descInput.setAttribute("aria-label", "技能描述");
		descInput.addEventListener("input", function () {
			refreshSkills();
			/* 类型勾选跟着描述自动勾（锁定技/限定技…）—— 见第四步 FLAG_TYPES */
			autoDetectFlags(item);
		});

		/* 台词与配音**不在这里** —— 它们搬到了页面最下面那一步（肆 · 更多拓展）。
		 * 技能卡只留名字与效果，不然一张卡越填越长；第四步会按技能数量与名字同步生成。 */

		body.appendChild(nameInput);
		body.appendChild(descInput);
		item._descEl = descInput;

		item.appendChild(head);
		item.appendChild(body);
		return item;
	}

	/* ── 技能音频 ────────────────────────────────────────────────────────
	 * 引擎那边技能的配音是有**序号**的：`audio: 2` 对应文件
	 * `<技能id>1.mp3`、`<技能id>2.mp3`（`docs/audio-guide.md`）。
	 * 所以这里收文件时**按顺序编号**，第 1 个文件就是第 1 句台词的配音。
	 *
	 * 文件名必须等于**技能 id**（AI 生成的英文/拼音），用户填的技能名是中文，
	 * 当不了文件名 —— 所以命名交给 AI，工坊只管收文件、试听、排序。
	 *
	 * 试听走 blob URL，纯本地播放，不经过服务端。 */
	function makeSkillAudio() {
		var root = document.createElement("div");
		root.className = "skill-audio";

		var head = document.createElement("div");
		head.className = "skill-audio__head";

		var label = document.createElement("span");
		label.className = "skill-audio__label";
		label.textContent = "配音";

		var pick = document.createElement("button");
		pick.type = "button";
		pick.className = "btn btn--ghost btn--tight";
		pick.textContent = "+ 选择音频";

		var hint = document.createElement("span");
		hint.className = "skill-audio__hint";
		hint.textContent = "按顺序对应第 1 句、第 2 句…";

		var file = document.createElement("input");
		file.type = "file";
		file.accept = "audio/*";
		file.multiple = true;
		file.className = "visually-hidden";

		var list = document.createElement("div");
		list.className = "skill-audio__list";

		var player = document.createElement("audio");
		player.hidden = true;

		root._audioFiles = [];
		root._player = player;

		pick.addEventListener("click", function () {
			file.click();
		});

		file.addEventListener("change", function () {
			Array.prototype.forEach.call(file.files || [], function (f) {
				if (root._audioFiles.length >= AUDIO_MAX_COUNT) {
					announce("一个技能最多放 " + AUDIO_MAX_COUNT + " 个配音文件，多出来的没收。");
					return;
				}
				if (!f.size) {
					announce("「" + f.name + "」是个空文件（0 字节），没收。");
					return;
				}
				if (f.size > AUDIO_MAX_BYTES) {
					announce("「" + f.name + "」超过 " + AUDIO_MAX_MB + "MB，没收。音频太大会让扩展包变得很难发出去。");
					return;
				}
				root._audioFiles.push(f);
				/* 只按体积拦不住「低码率的长音频」：5MB 以内也可能有几十分钟，
				 * 而技能语音通常只有几秒到十几秒。读得出时长就提示一句，不拦。 */
				checkAudioDuration(f, function (sec) {
					if (sec && sec > AUDIO_LONG_SECONDS) {
						announce(
							"「" + f.name + "」时长 " + formatSeconds(sec) +
								"，有点长 —— 技能语音一般只有几秒到十几秒，确认一下是不是要放的那一版。",
						);
					}
				});
			});
			file.value = ""; /* 允许再次选同一个文件 */
			renderAudioChips(root);
		});

		["play", "pause", "ended"].forEach(function (type) {
			player.addEventListener(type, function () {
				syncAudioButtons(root);
			});
		});

		head.appendChild(label);
		head.appendChild(pick);
		head.appendChild(hint);
		head.appendChild(file);
		root.appendChild(head);
		root.appendChild(list);
		root.appendChild(player);
		return root;
	}

	function renderAudioChips(root) {
		var list = root.querySelector(".skill-audio__list");
		list.textContent = "";
		root._audioFiles.forEach(function (f, i) {
			var chip = document.createElement("span");
			chip.className = "audio-chip";
			chip._file = f;

			var idx = document.createElement("span");
			idx.className = "audio-chip__index";
			idx.textContent = "第 " + (i + 1) + " 句";

			var nm = document.createElement("span");
			nm.className = "audio-chip__name";
			nm.textContent = f.name;

			var sz = document.createElement("span");
			sz.className = "audio-chip__size";
			sz.textContent = formatAudioSize(f.size);

			/* 上移 / 下移：顺序就是「第几句」，传错了要能调回来。
			 * 首/末项对应的按钮禁用，避免点了没反应。 */
			var up = document.createElement("button");
			up.type = "button";
			up.className = "audio-chip__btn audio-chip__btn--move";
			up.textContent = "↑";
			up.setAttribute("aria-label", "这一句上移");
			up.disabled = i === 0;
			up.addEventListener("click", function () {
				swapAudio(root, i, i - 1);
			});

			var down = document.createElement("button");
			down.type = "button";
			down.className = "audio-chip__btn audio-chip__btn--move";
			down.textContent = "↓";
			down.setAttribute("aria-label", "这一句下移");
			down.disabled = i === root._audioFiles.length - 1;
			down.addEventListener("click", function () {
				swapAudio(root, i, i + 1);
			});

			var play = document.createElement("button");
			play.type = "button";
			play.className = "audio-chip__btn audio-chip__btn--play";
			play.textContent = "试听";
			play.addEventListener("click", function () {
				toggleAudioPreview(root, f);
			});

			var del = document.createElement("button");
			del.type = "button";
			del.className = "audio-chip__btn audio-chip__btn--del";
			del.textContent = "×";
			del.setAttribute("aria-label", "移除这个音频");
			del.addEventListener("click", function () {
				var at = root._audioFiles.indexOf(f);
				if (at >= 0) root._audioFiles.splice(at, 1);
				if (root._player._file === f) stopAudioPreview(root);
				renderAudioChips(root);
			});

			chip.appendChild(idx);
			chip.appendChild(nm);
			chip.appendChild(sz);
			chip.appendChild(up);
			chip.appendChild(down);
			chip.appendChild(play);
			chip.appendChild(del);
			list.appendChild(chip);
		});
	}

	/* 交换两条配音的位置（顺序即「第几句」）。 */
	function swapAudio(root, a, b) {
		var arr = root._audioFiles;
		if (a < 0 || b < 0 || a >= arr.length || b >= arr.length) return;
		var tmp = arr[a];
		arr[a] = arr[b];
		arr[b] = tmp;
		renderAudioChips(root);
	}

	function formatAudioSize(bytes) {
		if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
		return Math.max(1, Math.round(bytes / 1024)) + " KB";
	}

	function formatSeconds(sec) {
		var s = Math.round(sec);
		if (s < 60) return s + " 秒";
		return Math.floor(s / 60) + " 分 " + (s % 60) + " 秒";
	}

	/* 读音频时长。只读元数据、不整段加载；读不出来（或环境不支持）就当没有 ——
	 * 这个检查只是提示，不能因为它把选文件卡住。 */
	function checkAudioDuration(f, done) {
		var url = null;
		var a = document.createElement("audio");
		var settled = false;
		var finish = function (sec) {
			if (settled) return;
			settled = true;
			if (url) URL.revokeObjectURL(url);
			done(sec);
		};
		try {
			url = URL.createObjectURL(f);
			a.preload = "metadata";
			a.addEventListener("loadedmetadata", function () {
				finish(isFinite(a.duration) ? a.duration : null);
			});
			a.addEventListener("error", function () {
				finish(null);
			});
			a.src = url;
		} catch (e) {
			finish(null);
			return;
		}
		setTimeout(function () {
			finish(null);
		}, 3000);
	}

	/* 点「试听」：同一个文件再点是暂停/继续，换文件则从头播。 */
	function toggleAudioPreview(root, f) {
		var player = root._player;
		if (player._file === f) {
			if (player.paused) playAudio(player);
			else player.pause();
			return;
		}
		stopAudioPreview(root);
		player._file = f;
		player._url = URL.createObjectURL(f);
		player.src = player._url;
		playAudio(player);
	}

	/* 浏览器会拦「没有用户手势」的自动播放（`NotAllowedError`）。
	 * 真实点击通常不会被拦，但被拦时**必须说一声** —— 否则用户以为按钮坏了。
	 * 不 catch 的话这个拒绝是静默的（promise 没人接）。 */
	function playAudio(player) {
		var playing = player.play();
		if (playing && playing.catch) {
			playing.catch(function () {
				announce("浏览器拦下了自动播放 —— 再点一次「试听」就能放。");
			});
		}
	}

	function stopAudioPreview(root) {
		var player = root._player;
		player.pause();
		player.removeAttribute("src");
		player._file = null;
		if (player._url) {
			URL.revokeObjectURL(player._url);
			player._url = null;
		}
	}

	function syncAudioButtons(root) {
		var player = root._player;
		Array.prototype.forEach.call(root.querySelectorAll(".audio-chip"), function (chip) {
			var btn = chip.querySelector(".audio-chip__btn--play");
			if (!btn) return;
			var isPlaying = chip._file && chip._file === player._file && !player.paused;
			btn.textContent = isPlaying ? "暂停" : "试听";
		});
	}

	/* 提交时把音频一个个上传，路径按「技能序号 + 第几句」回填到 payload。
	 * 不塞进 handoff 的 JSON：mp3 动辄几 MB，base64 之后会把它撑爆
	 * （立绘裁完才 45KB 左右，mp3 是它的几十倍）。
	 *
	 * 配音和台词一样在第四步，不在技能卡里。 */
	function uploadAudioForSkills(payload) {
		var jobs = [];
		moreSkillBlocks().forEach(function (blk, i) {
			var files = blk._audioEl ? blk._audioEl._audioFiles || [] : [];
			if (!files.length || !payload.skills[i]) return;
			files.forEach(function (f, n) {
				jobs.push(
					uploadOneAudio(f).then(function (path) {
						return { i: i, n: n, path: path };
					}),
				);
			});
		});
		if (!jobs.length) return Promise.resolve();

		return Promise.all(jobs).then(function (done) {
			done.sort(function (a, b) {
				return a.n - b.n;
			});
			done.forEach(function (d) {
				var skill = payload.skills[d.i];
				if (!skill) return;
				(skill.audioFiles = skill.audioFiles || []).push(d.path);
			});
		});
	}

	function uploadOneAudio(file) {
		return new Promise(function (resolve, reject) {
			var fr = new FileReader();
			fr.onerror = function () {
				reject(new Error("读不了「" + file.name + "」"));
			};
			fr.onload = function () {
				fetch("/api/audio", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: file.name, data: String(fr.result) }),
				})
					.then(function (r) {
						return r.json().then(function (d) {
							if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
							return d.path;
						});
					})
					.then(resolve, reject);
			};
			fr.readAsDataURL(file);
		});
	}

	/* 一行一句 → 数组；空行和首尾空白丢掉。台词不填就是空数组。 */
	function splitLines(raw) {
		return String(raw || "")
			.split("\n")
			.map(function (s) {
				return s.trim();
			})
			.filter(function (s) {
				return s !== "";
			});
	}

	function getSkills() {
		/* 台词、类型勾选、补充说明**不在技能卡里**，在第四步 —— 按技能卡的 `_key` 取回。
		 * 第四步收起（hidden）时控件仍在 DOM 里，值照样读得到。 */
		var byKey = {};
		moreSkillBlocks().forEach(function (blk) {
			byKey[blk._key] = {
				lines: blk._linesEl.value,
				types: Object.keys(blk._flagBoxes || {}).filter(function (k) {
					return blk._flagBoxes[k].checked;
				}),
				notes: blk._notesEl ? blk._notesEl.value : "",
			};
		});
		return Array.prototype.map.call(skillList.querySelectorAll(".skill-item"), function (item) {
			var areas = item.querySelectorAll("textarea");
			var mine = byKey[item._key] || {};
			var skill = {
				name: item.querySelector("input").value.trim(),
				desc: areas[0] ? areas[0].value.trim() : "",
				sample: item.getAttribute("data-sample") === "true",
			};
			var lines = splitLines(mine.lines || "");
			if (lines.length) skill.lines = lines;
			if (mine.types && mine.types.length) skill.types = mine.types;
			var notes = (mine.notes || "").trim();
			if (notes) skill.notes = notes;
			return skill;
		});
	}

	/* 重排序号、维护删除按钮状态（至少保留一个技能），并刷新卡面 */
	function refreshSkills() {
		var items = skillList.querySelectorAll(".skill-item");
		Array.prototype.forEach.call(items, function (item, index) {
			item.querySelector(".skill-item__index").textContent = skillLabel(index);
			item.querySelector(".skill-item__remove").disabled = items.length <= 1;
		});
		/* 技能改名 / 增删后，第四步的标题也要跟着走 */
		syncMoreSkillNames();
		renderCard();
	}

	/* 技能留空时头部显示什么：示例位给示例名，其余给「未命名技能」 */
	function skillNameFallback(item) {
		return "未命名技能";
	}

	/* 展开 / 收起一张技能卡。抽成公共函数，供点击、键盘和新增加技能三处共用。 */
	function setSkillOpen(item, open) {
		item.setAttribute("data-open", open ? "true" : "false");
		var head = item.querySelector(".skill-item__head");
		if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
		var toggle = item.querySelector(".skill-item__toggle");
		if (toggle) toggle.textContent = open ? "收起" : "展开";
	}

	function addSkill(name, desc, isSample, lines, keepOpen) {
		var card = makeSkillItem(name, desc);
		if (isSample) card.setAttribute("data-sample", "true");
		skillList.appendChild(card);

		/* 折叠策略：
		 * 从第三张起，每加一张**只把最上面那张还展开的**收起来 ——
		 * 于是展开的卡始终不超过两张，这块区域的高度每加一次只降一档。
		 * 以前是一次把所有展开的卡全收掉：按一下「添加技能」同时塌好几张，
		 * 高度和滚动位置猛地一抖（现在改成一次一张，就是为了不抖）。
		 * 第三张之前一概不动：起手本来就是两张展开的示例卡，那两张不该被折。
		 * keepOpen 是初始那两张示例卡专用的开关，跳过这套逻辑。 */
		if (!keepOpen && skillList.querySelectorAll(".skill-item").length >= 3) {
			var topOpen = skillList.querySelector('.skill-item[data-open="true"]');
			/* 若前面几张都被手动收起了，topOpen 就是刚加的这张 —— 不要把自身收起 */
			if (topOpen && topOpen !== card) setSkillOpen(topOpen, false);
		}
		renderMoreSkills();

		/* 台词回填：来自「修改已有」时读出来的原值。
		 * 先重建再写入 —— 块是按清单同步生成的，写早了会被下一次重建冲掉。 */
		if (lines && lines.length) {
			var mine = moreSkillBlocks();
			var last = mine[mine.length - 1];
			if (last) last._linesEl.value = lines.join("\n");
		}
		refreshSkills();

		/* 技能列表现在是限高可滚的：新加的那张默认在底部，
		 * 不主动滚进视野就被挡在可视区外，用户会以为点了没反应。
		 * keepOpen（初始两张示例卡）不走这里 —— 页面刚加载不该乱滚。 */
		if (!keepOpen && typeof card.scrollIntoView === "function") {
			card.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
		return card;
	}

	/* ── 肆 · 更多拓展 ────────────────────────────────────────────────────
	 * 技能卡上只留「名字 + 效果」，台词与配音搬到这里 —— 一张卡越填越长，
	 * 而多数武将根本没有配音，不该让它占着技能卡的位置。
	 *
	 * 这里跟着技能列表同步：加一个技能多一块、删一个少一块、改名标题跟着变。
	 * 对齐用每张卡终身不变的 `_key`，不用列表下标（理由见 skillSeq 的注释）。
	 *
	 * 另两样也在这儿：阵亡台词、皮肤形态。都是可选项，不填就不生成。 */
	var morePanel = $("more-panel");
	var moreToggle = $("more-toggle");
	var moreSkillsRoot = $("more-skills");
	var dieInput = $("f-die");
	var skinRoot = $("skin-list");
	var addSkinBtn = $("add-skin");
	var gzGroupSel = $("f-gz-group");
	var gzGroups = $("gz-groups");
	var clanInput = $("f-clan");
	var bioInput = $("f-intro-bio");

	/* 形态上限：再多玩家也点不过来（皮肤列表是一排按钮，横着滚的） */
	var SKIN_MAX_COUNT = 8;

	/* 技能类型勾选：勾选框自动跟着描述里的关键词走（描述写「锁定技」就自动勾上），
	 * 用户可以再手动改 —— 改完到下次描述变动前一直保留。
	 * AI 落盘映射（规范 5.2）：locked→locked+forced 两个都要写；limited 一项白拿自动补；
	 * juexingji/zhuanhuanji/dutySkill 只给标签，效果照旧要写；zhuSkill 主公技；clanSkill 宗族技。 */
	var FLAG_TYPES = [
		["locked", "锁定技", "锁定技"],
		["limited", "限定技", "限定技"],
		["juexingji", "觉醒技", "觉醒技"],
		["zhuanhuanji", "转换技", "转换技"],
		["zhuSkill", "主公技", "主公技"],
		["dutySkill", "使命技", "使命技"],
		["clanSkill", "宗族技", "宗族"],
	];

	function moreSkillBlocks() {
		if (!moreSkillsRoot) return []; /* 页面没第四步时不该拖垮主表单 */
		return Array.prototype.slice.call(moreSkillsRoot.querySelectorAll(".more-skill"));
	}

	/* 一个技能一块：技能标题（跟着上面同步）+ 台词框 + 配音收集器 */
	function makeMoreSkillBlock(key, index, saved) {
		var block = document.createElement("div");
		block.className = "more-skill";
		block._key = key;

		var head = document.createElement("div");
		head.className = "more-skill__head";

		var idx = document.createElement("span");
		idx.className = "more-skill__index";
		idx.textContent = skillLabel(index);

		var nm = document.createElement("span");
		nm.className = "more-skill__name";
		nm.textContent = "未命名技能";

		head.appendChild(idx);
		head.appendChild(nm);

		var lines = document.createElement("textarea");
		lines.className = "field__input field__input--area field__input--lines";
		lines.rows = 2;
		lines.placeholder = "台词（可选，一行一句）：发动时念的话";
		lines.setAttribute("aria-label", "技能台词");
		lines.value = (saved && saved.lines) || "";

		/* 配音：第 n 个文件对应第 n 句台词（引擎按 <技能id>n.mp3 读，见 docs/audio-guide.md） */
		var audio = makeSkillAudio();
		if (saved && saved.audio && saved.audio.length) {
			audio._audioFiles = saved.audio.slice();
			renderAudioChips(audio);
		}

		/* 类型勾选行：自动跟着描述关键词勾，用户可再手动改。
		 * 锁定技是行为字段（locked+forced 都要写），宗族技是显示标签 —— 性质不同但交互一样。 */
		var flags = document.createElement("div");
		flags.className = "skill-flags";
		block._flagBoxes = {};
		FLAG_TYPES.forEach(function (pair) {
			var label = document.createElement("label");
			label.className = "gz-check";
			var box = document.createElement("input");
			box.type = "checkbox";
			box.value = pair[0];
			box.checked = !!(saved && saved.types && saved.types.indexOf(pair[0]) >= 0);
			box.setAttribute("aria-label", "标为" + pair[1]);
			label.appendChild(box);
			label.appendChild(document.createTextNode(pair[1]));
			flags.appendChild(label);
			block._flagBoxes[pair[0]] = box;
		});

		block._linesEl = lines;
		block._nameEl = nm;
		block._audioEl = audio;

		/* 补充说明：写不进技能描述的效果细节都在这 —— AI 按内容落到对应机制
		 * （动态显示按 7.9、使命成败按使命技结构、觉醒/转换按描述、数值按描述）。
		 * 例子的口径：三类各举一条 —— 动态显示 / 觉醒条件 /
		 * 技能变身时机与转换技两态，用户照着格式写就行。
		 * 框高保持 6 行：这是真实输入区（上限 800 字），不随示例条数增减。 */
		var notes = document.createElement("textarea");
		notes.className = "field__input field__input--area field__input--lines";
		notes.rows = 6;
		notes.maxLength = 800;
		notes.placeholder =
			"补充说明（可选）：写不进技能描述的效果细节，在此填写。\n" +
			"建议覆盖：触发时机 / 频率 / 目标 / 数值 / 边界。例如：\n" +
			"动态显示→发动技能后在描述里划掉对应分支\n" +
			"觉醒条件 → 准备阶段体力不大于 2；觉醒后获得〖铁骑〗\n" +
			"技能变身时机、转换技两态效果";
		notes.setAttribute("aria-label", "补充说明");
		notes.value = (saved && saved.notes) || "";

		block.appendChild(head);
		block.appendChild(lines);
		block.appendChild(audio);
		block.appendChild(flags);
		block.appendChild(notes);
		block._notesEl = notes;
		return block;
	}

	/* 按当前技能列表重建第四步的技能块。
	 * 已填的台词与已选的配音按 `_key` 留下来 —— 删掉中间某个技能时，
	 * 剩下的技能各拿回自己的那份，不会被邻居顶替。 */
	function renderMoreSkills() {
		if (!moreSkillsRoot) return;
		var saved = {};
		moreSkillBlocks().forEach(function (blk) {
			/* 重建前先停掉正在播放的，一并释放 blob URL */
			stopAudioPreview(blk._audioEl);
			saved[blk._key] = {
				lines: blk._linesEl.value,
				audio: blk._audioEl._audioFiles,
				types: Object.keys(blk._flagBoxes).filter(function (k) {
					return blk._flagBoxes[k].checked;
				}),
				notes: blk._notesEl ? blk._notesEl.value : "",
			};
		});

		moreSkillsRoot.textContent = "";
		Array.prototype.forEach.call(skillList.querySelectorAll(".skill-item"), function (item, i) {
			moreSkillsRoot.appendChild(makeMoreSkillBlock(item._key, i, saved[item._key]));
		});
		/* 新块（没有手动状态可继承的）按描述跑一遍自动勾选 ——
		 * 「修改已有」读回的描述就靠这一次点亮对应类型；
		 * 已有手动状态的块不动，否则加个技能会把用户的勾全冲掉。 */
		Array.prototype.forEach.call(skillList.querySelectorAll(".skill-item"), function (item) {
			if (!saved[item._key] || !saved[item._key].types) autoDetectFlags(item);
		});
		syncMoreSkillNames();
	}

	/* 描述里的关键词 → 自动勾类型。描述每次输入都会重算 ——
	 * 手动勾/取消在下次描述变动前一直保留。 */
	function autoDetectFlags(item) {
		if (!item._key || !item._descEl) return;
		var blk = moreSkillBlocks().filter(function (b) {
			return b._key === item._key;
		})[0];
		if (!blk || !blk._flagBoxes) return;
		var desc = item._descEl.value;
		FLAG_TYPES.forEach(function (pair) {
			var box = blk._flagBoxes[pair[0]];
			if (box) box.checked = desc.indexOf(pair[2]) >= 0;
		});
	}

	/* 只改标题文本，不重建 —— 每敲一个字都重建会把正在输入的换行都吃掉 */
	function syncMoreSkillNames() {
		if (!moreSkillsRoot) return;
		var items = skillList.querySelectorAll(".skill-item");
		moreSkillBlocks().forEach(function (blk, i) {
			var item = items[i];
			if (!item) return;
			blk._nameEl.textContent = item._nameEl.value.trim() || skillNameFallback(item);
		});
	}

	/* ── 皮肤形态 ────────────────────────────────────────────────────────
	 * 走的是「玩家自选皮肤」那条路：多放几张图 + 角色上写一行 skinPath。
	 * 为什么必须显式写 skinPath —— 引擎默认取「图片路径去掉末两级目录 + /skin/<角色id>/」
	 * （引擎 `get.skinPath` 的推导），而我们的立绘放在扩展根目录（不在 pictures/ 子目录），
	 * 照它推导会漏掉扩展名，算成 `extension/skin/<角色id>/`，自然一张都找不到。
	 *
	 * **形态名就是文件名**：游戏里「更改皮肤」那排按钮的标题取的是
	 * `get.translation(文件名去掉扩展名)`，
	 * 而 `get.translation` 查不到时会原样返回 —— 所以中文名可以直接用。 */
	function makeSkinRow(file) {
		var row = document.createElement("div");
		row.className = "skin-chip";
		row._file = file;

		var thumb = document.createElement("img");
		thumb.className = "skin-chip__thumb";
		thumb.alt = "";

		var fields = document.createElement("div");
		fields.className = "skin-chip__fields";

		var nameInput = document.createElement("input");
		nameInput.type = "text";
		nameInput.className = "field__input skin-chip__name";
		nameInput.maxLength = 12;
		nameInput.placeholder = "形态名";
		nameInput.value = String(file.name || "")
			.replace(/\.[^.]+$/, "")
			.slice(0, 12);
		nameInput.setAttribute("aria-label", "形态名");

		/* 变身名：该皮肤被技能变身（路线 B）时，玩家牌上显示的名字。
		 * 不填就用形态名。AI 会照它生成 characterSubstitute 与翻译。 */
		var tempInput = document.createElement("input");
		tempInput.type = "text";
		tempInput.className = "field__input skin-chip__name";
		tempInput.maxLength = 12;
		tempInput.placeholder = "变身名（可选）";
		tempInput.setAttribute("aria-label", "变身名");

		var note = document.createElement("span");
		note.className = "skin-chip__note";
		note.textContent = "处理中…";

		var del = document.createElement("button");
		del.type = "button";
		del.className = "btn btn--ghost btn--tight";
		del.textContent = "移除";
		del.addEventListener("click", function () {
			row.remove();
		});

		/* 调整构图：展开卡内的裁剪器（滑块控制上下位置 + 缩放） */
		var adj = document.createElement("button");
		adj.type = "button";
		adj.className = "btn btn--ghost btn--tight";
		adj.textContent = "调整";
		adj.addEventListener("click", function () {
			openSkinCrop(row);
		});

		var actions = document.createElement("div");
		actions.className = "skin-chip__actions";
		actions.appendChild(adj);
		actions.appendChild(del);

		fields.appendChild(nameInput);
		fields.appendChild(tempInput);
		fields.appendChild(note);
		fields.appendChild(actions);
		row.appendChild(thumb);
		row.appendChild(fields);

		row._thumb = thumb;
		row._nameEl = nameInput;
		row._tempEl = tempInput;
		row._noteEl = note;
		return row;
	}

	/* ── 形态裁剪弹窗 ─────────────────────────────────────────────────────
	 * 点形态卡片的「调整」在网页中央弹出矩形框，交互与右侧立绘裁剪器一致：
	 * 拖拽移动 + 滚轮缩放 + 缩放滑杆。但状态**完全独立**（skinCrop 对象），
	 * 不碰右侧立绘裁剪器的全局 crop —— 两边各裁各的，互不串。 */
	var skinCropModal = null;
	var skinCrop = {
		viewport: null,
		image: null,
		zoom: null,
		empty: null,
		natural: { w: 0, h: 0 },
		baseScale: 1,
		zoomVal: 1,
		offsetX: 0,
		offsetY: 0,
		hasImage: false,
		row: null,
		dragging: false,
		startX: 0,
		startY: 0,
		originX: 0,
		originY: 0,
	};

	function skinCropViewport() {
		return { w: skinCrop.viewport.clientWidth, h: skinCrop.viewport.clientHeight };
	}

	function skinCropComputeBase() {
		var vp = skinCropViewport();
		if (!skinCrop.natural.w || !skinCrop.natural.h) return 1;
		return Math.max(vp.w / skinCrop.natural.w, vp.h / skinCrop.natural.h);
	}

	function skinCropConstrain() {
		var vp = skinCropViewport();
		var scale = skinCrop.baseScale * skinCrop.zoomVal;
		var drawW = skinCrop.natural.w * scale;
		var drawH = skinCrop.natural.h * scale;
		skinCrop.offsetX = clamp(skinCrop.offsetX, vp.w - drawW, 0);
		skinCrop.offsetY = clamp(skinCrop.offsetY, vp.h - drawH, 0);
	}

	function skinCropPaint() {
		if (!skinCrop.hasImage) return;
		var scale = skinCrop.baseScale * skinCrop.zoomVal;
		skinCrop.image.style.transform =
			"translate(" + skinCrop.offsetX + "px, " + skinCrop.offsetY + "px) scale(" + scale + ")";
	}

	function skinCropCenter() {
		if (!skinCrop.hasImage) return;
		skinCrop.baseScale = skinCropComputeBase();
		var vp = skinCropViewport();
		var scale = skinCrop.baseScale * skinCrop.zoomVal;
		var drawW = skinCrop.natural.w * scale;
		var drawH = skinCrop.natural.h * scale;
		skinCrop.offsetX = (vp.w - drawW) / 2;
		skinCrop.offsetY = (vp.h - drawH) * AUTO_VERTICAL_BIAS;
		skinCropConstrain();
		skinCropPaint();
	}

	function skinCropSetHasImage(has) {
		skinCrop.hasImage = has;
		if (skinCrop.image) skinCrop.image.hidden = !has;
		if (skinCrop.empty) skinCrop.empty.hidden = has;
		if (!has && skinCrop.image) skinCrop.image.style.transform = "";
	}

	function skinCropExport() {
		if (!skinCrop.hasImage) return null;
		var vp = skinCropViewport();
		var scale = skinCrop.baseScale * skinCrop.zoomVal;
		var canvas = document.createElement("canvas");
		canvas.width = AVATAR_W;
		canvas.height = AVATAR_H;
		var ctx = canvas.getContext("2d");
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(
			skinCrop.image,
			-skinCrop.offsetX / scale,
			-skinCrop.offsetY / scale,
			vp.w / scale,
			vp.h / scale,
			0,
			0,
			AVATAR_W,
			AVATAR_H,
		);
		return canvas.toDataURL("image/jpeg", 0.92);
	}

	function openSkinCrop(row) {
		if (!row._sourceImg) {
			announce("这张图还在处理中，稍等一下再调。");
			return;
		}
		skinCrop.row = row;
		/* 用原图开弹窗：先读 natural 尺寸，再算 cover 基准、居中 */
		var probe = new Image();
		probe.onload = function () {
			skinCrop.natural.w = probe.naturalWidth;
			skinCrop.natural.h = probe.naturalHeight;
			skinCrop.image.src = probe.src;
			skinCrop.zoomVal = 1;
			skinCrop.zoom.value = "1";
			skinCropSetHasImage(true);
			skinCropCenter();
		};
		probe.src = row._sourceImg.src;
		skinCropModal.hidden = false;
	}

	function closeSkinCrop() {
		skinCropModal.hidden = true;
		skinCrop.row = null;
		skinCropSetHasImage(false);
	}

	function bindSkinCrop() {
		skinCropModal = $("skin-crop-modal");
		skinCrop.viewport = $("skin-crop-viewport");
		skinCrop.image = $("skin-crop-image");
		skinCrop.empty = $("skin-crop-empty");
		skinCrop.zoom = $("skin-crop-zoom");
		if (!skinCropModal || !skinCrop.viewport || !skinCrop.image) return;

		/* 拖动 */
		skinCrop.viewport.addEventListener("pointerdown", function (event) {
			if (!skinCrop.hasImage) return;
			skinCrop.dragging = true;
			skinCrop.startX = event.clientX;
			skinCrop.startY = event.clientY;
			skinCrop.originX = skinCrop.offsetX;
			skinCrop.originY = skinCrop.offsetY;
			skinCrop.viewport.classList.add("is-dragging");
			skinCrop.viewport.setPointerCapture(event.pointerId);
		});
		skinCrop.viewport.addEventListener("pointermove", function (event) {
			if (!skinCrop.dragging) return;
			skinCrop.offsetX = skinCrop.originX + (event.clientX - skinCrop.startX);
			skinCrop.offsetY = skinCrop.originY + (event.clientY - skinCrop.startY);
			skinCropConstrain();
			skinCropPaint();
		});
		function endSkinDrag(event) {
			if (!skinCrop.dragging) return;
			skinCrop.dragging = false;
			skinCrop.viewport.classList.remove("is-dragging");
			if (event.pointerId !== undefined && skinCrop.viewport.hasPointerCapture(event.pointerId)) {
				skinCrop.viewport.releasePointerCapture(event.pointerId);
			}
		}
		skinCrop.viewport.addEventListener("pointerup", endSkinDrag);
		skinCrop.viewport.addEventListener("pointercancel", endSkinDrag);

		/* 滚轮缩放（以视口中心为锚点） */
		skinCrop.viewport.addEventListener(
			"wheel",
			function (event) {
				if (!skinCrop.hasImage) return;
				event.preventDefault();
				var vp = skinCropViewport();
				var factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
				var nextZoom = clamp(skinCrop.zoomVal * factor, 1, MAX_ZOOM);
				var prevScale = skinCrop.baseScale * skinCrop.zoomVal;
				var anchorX = (vp.w / 2 - skinCrop.offsetX) / prevScale;
				var anchorY = (vp.h / 2 - skinCrop.offsetY) / prevScale;
				var nextScale = skinCrop.baseScale * nextZoom;
				skinCrop.zoomVal = nextZoom;
				skinCrop.offsetX = vp.w / 2 - anchorX * nextScale;
				skinCrop.offsetY = vp.h / 2 - anchorY * nextScale;
				skinCrop.zoom.value = String(nextZoom);
				skinCropConstrain();
				skinCropPaint();
			},
			{ passive: false },
		);

		/* 缩放滑杆 */
		skinCrop.zoom.addEventListener("input", function () {
			if (!skinCrop.hasImage) return;
			skinCrop.zoomVal = Number(skinCrop.zoom.value);
			skinCropConstrain();
			skinCropPaint();
		});

		/* 保存 / 取消 / 关闭 / 点背景关闭 */
		$("skin-crop-save").addEventListener("click", function () {
			if (!skinCrop.row) return;
			var dataUrl = skinCropExport();
			if (!dataUrl) return;
			skinCrop.row._dataUrl = dataUrl;
			skinCrop.row._thumb.src = dataUrl;
			skinCrop.row._noteEl.textContent = "已裁成 " + AVATAR_W + " × " + AVATAR_H;
			closeSkinCrop();
		});
		$("skin-crop-cancel").addEventListener("click", closeSkinCrop);
		$("skin-crop-close").addEventListener("click", closeSkinCrop);
		$("skin-crop-backdrop").addEventListener("click", closeSkinCrop);
	}

	function addSkinFiles(files) {
		Array.prototype.forEach.call(files || [], function (f) {
			if (!/^image\//.test(f.type)) {
				announce("「" + f.name + "」不是图片，没加。");
				return;
			}
			if (skinRoot.children.length >= SKIN_MAX_COUNT) {
				announce("最多 " + SKIN_MAX_COUNT + " 个形态，多出来的没加。");
				return;
			}
			var row = makeSkinRow(f);
			skinRoot.appendChild(row);
			/* 留一份原图，供「调整构图」的卡内裁剪器用（自动裁好的在 row._dataUrl） */
			ciReadAsDataUrl(f).then(function (url) {
				var img = new Image();
				img.onload = function () { row._sourceImg = img; };
				img.onerror = function () {};
				img.src = url;
			});
			/* 统一裁成头像规格：引擎把皮肤图铺在按钮上当背景，
			 * 尺寸不一时会拉伸变形。这里的构图偏好与右侧裁剪器一致（偏上，保住头部）。 */
			fileToAvatarDataUrl(f).then(function (dataUrl) {
				row._dataUrl = dataUrl;
				row._thumb.src = dataUrl;
				row._noteEl.textContent = "已裁成 " + AVATAR_W + " × " + AVATAR_H;
			}, function (err) {
				row.remove();
				announce(err.message || "这张图读不出来，已跳过。");
			});
		});
	}

	/* 读一张图 → 画成 350×464 的 jpeg dataURL。独立于裁剪器的全局状态，
	 * 所以给它自己一份实现，不去碰 crop（那里面是用户的立绘，不能串）。 */
	function fileToAvatarDataUrl(file) {
		return new Promise(function (resolve, reject) {
			var fr = new FileReader();
			fr.onerror = function () {
				reject(new Error("「" + file.name + "」读不出来"));
			};
			fr.onload = function () {
				var img = new Image();
				img.onerror = function () {
					reject(new Error("「" + file.name + "」不是能显示的图片"));
				};
				img.onload = function () {
					resolve(renderImageToAvatar(img));
				};
				img.src = String(fr.result);
			};
			fr.readAsDataURL(file);
		});
	}

	/* 把一张图按「cover + 上下偏移 + 缩放」画到 350×464 画布，返回 canvas。
	 * bias：0 = 取顶部，0.14 = 默认偏上（保住头），1 = 取底部；
	 * zoom：1 = 刚好铺满，>1 = 放大（取景范围变小）。 */
	function renderAvatarWith(img, bias, zoom) {
		var nw = img.naturalWidth || img.width;
		var nh = img.naturalHeight || img.height;
		if (!nw || !nh) throw new Error("这张图是空的");
		var scale = Math.max(AVATAR_W / nw, AVATAR_H / nh) * (zoom || 1);
		var drawW = nw * scale;
		var drawH = nh * scale;
		var canvas = document.createElement("canvas");
		canvas.width = AVATAR_W;
		canvas.height = AVATAR_H;
		var ctx = canvas.getContext("2d");
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(img, (AVATAR_W - drawW) / 2, (AVATAR_H - drawH) * (bias == null ? AUTO_VERTICAL_BIAS : bias), drawW, drawH);
		return canvas;
	}

	function renderImageToAvatar(img) {
		return renderAvatarWith(img, AUTO_VERTICAL_BIAS, 1).toDataURL("image/jpeg", 0.92);
	}

	/* 皮肤图上传：走独立接口落到工作区，handoff 的 JSON 里只记路径。
	 * 图虽然比 mp3 小（裁完约 45KB），但照样不塞进 JSON —— 那是一堆 base64。 */
	function uploadSkins(payload) {
		var rows = Array.prototype.slice.call(skinRoot.querySelectorAll(".skin-chip"));
		var jobs = [];
		rows.forEach(function (row) {
			var name = row._nameEl.value.trim();
			if (!name) {
				announce("有形态没填名字 —— 没名字的形态不会加进去。");
				return;
			}
			if (!row._dataUrl) return; /* 还在处理中 */
			jobs.push(
				uploadOneSkin(name, row._dataUrl).then(function (path) {
					/* 变身名：填了就交给 AI 生成路线 B（变身）的
					 * characterSubstitute 与翻译；不填则该皮肤只走路线 A（玩家手选） */
					var skin = { name: name, path: path };
					var tempname = row._tempEl ? row._tempEl.value.trim() : "";
					if (tempname) skin.tempname = tempname;
					return skin;
				}),
			);
		});
		if (!jobs.length) return Promise.resolve();
		return Promise.all(jobs).then(function (list) {
			if (list.length) payload.skins = list;
		});
	}

	function uploadOneSkin(name, dataUrl) {
		return fetch("/api/skin", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: name, data: dataUrl }),
		}).then(function (r) {
			return r.json().then(function (d) {
				if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
				return d.path;
			});
		});
	}

	/* 清空按钮走的清理：第四步在 <form> 之外，浏览器的 reset 够不着，
	 * 不清就会跟空表单一起交出去（阵亡台词、上次做的皮肤图都还在）。 */
	function resetMore() {
		if (dieInput) dieInput.value = "";
		if (skinRoot) skinRoot.textContent = "";
		if (gzGroupSel) gzGroupSel.value = "";
		if (clanInput) clanInput.value = "";
		if (bioInput) bioInput.value = "";
		if (gzGroups) {
			Array.prototype.forEach.call(gzGroups.querySelectorAll("input:checked"), function (box) {
				box.checked = false;
			});
		}
	}

	/* 展开 / 收起第四步。按钮文案与 aria-expanded 一起同步。 */
	function setMoreOpen(open) {
		if (!morePanel || !moreToggle) return;
		if (open) morePanel.removeAttribute("hidden");
		else morePanel.setAttribute("hidden", "");
		moreToggle.setAttribute("aria-expanded", open ? "true" : "false");
		var cap = moreToggle.querySelector(".more-toggle__label");
		if (cap) cap.textContent = open ? "收起拓展" : "更多拓展";
	}

	function bindMore() {
		if (moreToggle && morePanel) {
			moreToggle.addEventListener("click", function () {
				var opening = morePanel.hasAttribute("hidden");
				setMoreOpen(opening);
				/* 展开后自己也跑到视野里，不然点了没反应像坏了 */
				if (opening) morePanel.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}

		/* 「返回」：第四步在页面最下方，填完滚回上面的工作台。
		 * 顺带收起面板 —— 不收的话它还占着原来的位置，看着像没回去。 */
		var moreBack = $("more-back");
		if (moreBack) {
			moreBack.addEventListener("click", function () {
				setMoreOpen(false);
				var work = document.querySelector(".workshop") || document.body;
				work.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}

		if (addSkinBtn) {
			var picker = document.createElement("input");
			picker.type = "file";
			picker.accept = "image/*";
			picker.multiple = true;
			picker.className = "visually-hidden";
			document.body.appendChild(picker);
			addSkinBtn.addEventListener("click", function () {
				picker.click();
			});
			picker.addEventListener("change", function () {
				addSkinFiles(picker.files);
				picker.value = ""; /* 允许再次选同一个文件 */
			});
		}
	}

	/* ── 立绘裁剪器 ────────────────────────────────────────────────────── */
	var cropViewport = $("cropper-viewport");
	var cropImage = $("cropper-image");
	var cropEmpty = $("cropper-empty");
	var cropZoom = $("cropper-zoom");
	var cropExportBtn = $("cropper-export");
	var cropFile = $("cropper-file");
	var cropPick = $("cropper-pick");

	/* 裁剪状态：offset 为图片左上角相对视口的位移（CSS 像素） */
	var crop = {
		natural: { w: 0, h: 0 },
		baseScale: 1,
		zoom: 1,
		offsetX: 0,
		offsetY: 0,
		hasImage: false,
	};

	function viewportSize() {
		return {
			w: cropViewport.clientWidth,
			h: cropViewport.clientHeight,
		};
	}

	/* cover 基准缩放：保证图片始终铺满视口 */
	function computeBaseScale() {
		var vp = viewportSize();
		if (!crop.natural.w || !crop.natural.h) return 1;
		return Math.max(vp.w / crop.natural.w, vp.h / crop.natural.h);
	}

	/* 把位移约束在「图片始终覆盖视口」的范围内 */
	function constrain() {
		var vp = viewportSize();
		var scale = crop.baseScale * crop.zoom;
		var drawW = crop.natural.w * scale;
		var drawH = crop.natural.h * scale;
		var minX = vp.w - drawW;
		var minY = vp.h - drawH;
		crop.offsetX = clamp(crop.offsetX, minX, 0);
		crop.offsetY = clamp(crop.offsetY, minY, 0);
	}

	function paint() {
		if (!crop.hasImage) return;
		var scale = crop.baseScale * crop.zoom;
		cropImage.style.transform =
			"translate(" + crop.offsetX + "px, " + crop.offsetY + "px) scale(" + scale + ")";
	}

	/* 初始构图：水平居中 + 垂直偏上（保住人物头部）。
	 * 只在图片载入、视口尺寸变化时调用 —— 界面上不再提供「自动构图」按钮，
	 * 构图完全交给用户拖动决定。 */
	function centerCrop() {
		if (!crop.hasImage) return;
		/* 视口尺寸会因为字体加载、滚动条出现、断点切换而变化，
		 * 每次都重算基准缩放，否则会沿用旧的 cover 比例去居中。 */
		crop.baseScale = computeBaseScale();
		var vp = viewportSize();
		var scale = crop.baseScale * crop.zoom;
		var drawW = crop.natural.w * scale;
		var drawH = crop.natural.h * scale;
		crop.offsetX = (vp.w - drawW) / 2;
		crop.offsetY = (vp.h - drawH) * AUTO_VERTICAL_BIAS;
		constrain();
		paint();
	}

	function setHasImage(has) {
		crop.hasImage = has;
		cropImage.hidden = !has;
		cropEmpty.hidden = has;
		$("cropper").classList.toggle("has-image", has);
		cropZoom.disabled = !has;
		cropExportBtn.disabled = !has;
		card.classList.toggle("has-art", has);
		if (!has) {
			var ctx = artCanvas.getContext("2d");
			ctx.clearRect(0, 0, artCanvas.width, artCanvas.height);
		}
	}

	/* 清空裁剪器：换武将或点「清空」时用，避免残留上一张立绘。
	 * 必须连 <img> 的 src 属性一起移除 —— 只清状态的话，浏览器会保留上一次
	 * 加载的图，用户不提防就带着旧立绘提交了。 */
	function resetAvatar() {
		crop.natural = { w: 0, h: 0 };
		crop.baseScale = 1;
		crop.zoom = 1;
		crop.offsetX = 0;
		crop.offsetY = 0;
		if (cropImage) cropImage.removeAttribute("src");
		if (cropFile) cropFile.value = "";
		if (cropZoom) cropZoom.value = "1";
		setHasImage(false);
	}

	/* 卡面立绘画布 + 节流标记。
	 * 直接用 canvas 绘制到「显示尺寸 × 设备像素比」，不经过 toDataURL ——
	 * 既没有 JPEG 压缩损失，也不会因为缩放而发糊。 */
	var artCanvas = $("card-art-canvas");
	var previewPending = false;
	var previewDirty = false;

	/* 把裁剪结果同步到卡面立绘层。
	 *
	 * 坐标链路：裁剪视口里的可见区域 → 原图坐标 → 卡面画布像素。
	 * 卡面立绘层与头像规格同比例，因此这里几乎不会发生二次裁切。 */
	function syncCardArt() {
		if (!crop.hasImage) return;
		/* 正在等待下一帧时不要直接丢弃这次调用，标记为脏、帧末补画一次。
		 * 否则「点一下自动构图」这种单次调用若正好落在节流窗口内，就会永久丢失。 */
		if (previewPending) {
			previewDirty = true;
			return;
		}
		previewPending = true;
		requestAnimationFrame(function () {
			previewPending = false;
			previewDirty = false;
			if (!crop.hasImage) return;

			var vp = viewportSize();
			var scale = crop.baseScale * crop.zoom;
			var rect = artCanvas.getBoundingClientRect();
			var dpr = window.devicePixelRatio || 1;
			var w = Math.max(1, Math.round(rect.width * dpr));
			var h = Math.max(1, Math.round(rect.height * dpr));

			if (artCanvas.width !== w || artCanvas.height !== h) {
				artCanvas.width = w;
				artCanvas.height = h;
			}

			var ctx = artCanvas.getContext("2d");
			ctx.imageSmoothingQuality = "high";
			ctx.clearRect(0, 0, w, h);
			ctx.drawImage(
				cropImage,
				-crop.offsetX / scale,
				-crop.offsetY / scale,
				vp.w / scale,
				vp.h / scale,
				0,
				0,
				w,
				h,
			);

			card.classList.add("has-art");

			/* 绘制期间又来了新状态（拖动中的连续帧）→ 补画一次 */
			if (previewDirty) syncCardArt();
		});
	}

	function loadImageSource(src) {
		var probe = new Image();
		probe.onload = function () {
			cropImage.src = src;
			crop.natural.w = probe.naturalWidth;
			crop.natural.h = probe.naturalHeight;
			crop.baseScale = computeBaseScale();
			crop.zoom = 1;
			cropZoom.value = "1";
			setHasImage(true);
			centerCrop();
			syncCardArt();

			/* 横版图裁进竖版头像只能取到中段，提前讲清楚，免得用户以为裁坏了 */
			if (probe.naturalWidth > probe.naturalHeight * 1.2) {
				announce(
					"这张图偏横向（" +
						probe.naturalWidth +
						"×" +
						probe.naturalHeight +
						"）—— 裁进竖版头像只能取中段。建议换一张竖版立绘，或手动拖动圈出人物。",
				);
			} else {
				announce("立绘已载入 · 拖动调整位置，滚轮或滑块缩放。");
			}
		};
		probe.onerror = function () {
			announce("这张图片读不出来，换一张试试（支持 PNG / JPG / WebP）。");
		};
		probe.src = src;
	}

	function handleFiles(files) {
		var file = files && files[0];
		if (!file) return;
		if (!/^image\//.test(file.type)) {
			announce("只接受图片文件。");
			return;
		}
		var reader = new FileReader();
		reader.onload = function () {
			loadImageSource(String(reader.result));
		};
		reader.readAsDataURL(file);
	}

	/* 导出 350×464：把视口内容按原图坐标重绘到固定画布 */
	function exportAvatar() {
		if (!crop.hasImage) return;
		var vp = viewportSize();
		var scale = crop.baseScale * crop.zoom;
		var canvas = document.createElement("canvas");
		canvas.width = AVATAR_W;
		canvas.height = AVATAR_H;
		var ctx = canvas.getContext("2d");
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(
			cropImage,
			-crop.offsetX / scale,
			-crop.offsetY / scale,
			vp.w / scale,
			vp.h / scale,
			0,
			0,
			AVATAR_W,
			AVATAR_H,
		);

		var name = fieldValue("f-name") || "avatar";
		var fileName = name + ".jpg";

		canvas.toBlob(
			function (blob) {
				if (!blob) {
					announce("导出失败：浏览器未生成图片数据。");
					return;
				}
				var url = URL.createObjectURL(blob);
				var link = document.createElement("a");
				link.href = url;
				link.download = fileName;
				document.body.appendChild(link);
				link.click();
				link.remove();
				URL.revokeObjectURL(url);
				announce("已导出 " + fileName + " · " + AVATAR_W + "×" + AVATAR_H + "，放进扩展根目录即可。");
			},
			"image/jpeg",
			0.92,
		);
	}

	/* 指针拖动（鼠标与触摸统一走 Pointer Events） */
	function bindCropperDrag() {
		var dragging = false;
		var startX = 0;
		var startY = 0;
		var originX = 0;
		var originY = 0;

		cropViewport.addEventListener("pointerdown", function (event) {
			if (!crop.hasImage) return;
			dragging = true;
			startX = event.clientX;
			startY = event.clientY;
			originX = crop.offsetX;
			originY = crop.offsetY;
			cropViewport.classList.add("is-dragging");
			cropViewport.setPointerCapture(event.pointerId);
		});

		cropViewport.addEventListener("pointermove", function (event) {
			if (!dragging) return;
			crop.offsetX = originX + (event.clientX - startX);
			crop.offsetY = originY + (event.clientY - startY);
			constrain();
			paint();
			syncCardArt();
		});

		function endDrag(event) {
			if (!dragging) return;
			dragging = false;
			cropViewport.classList.remove("is-dragging");
			if (event.pointerId !== undefined && cropViewport.hasPointerCapture(event.pointerId)) {
				cropViewport.releasePointerCapture(event.pointerId);
			}
		}

		cropViewport.addEventListener("pointerup", endDrag);
		cropViewport.addEventListener("pointercancel", endDrag);
	}

	/* 滚轮缩放：以视口中心为锚点，手感比滑块更直接 */
	function bindCropperWheel() {
		cropViewport.addEventListener(
			"wheel",
			function (event) {
				if (!crop.hasImage) return;
				event.preventDefault();
				var vp = viewportSize();
				var factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
				var nextZoom = clamp(crop.zoom * factor, 1, MAX_ZOOM);

				/* 保持指针下方的内容不动：先算出锚点在原图中的位置，再回算位移 */
				var prevScale = crop.baseScale * crop.zoom;
				var anchorX = (vp.w / 2 - crop.offsetX) / prevScale;
				var anchorY = (vp.h / 2 - crop.offsetY) / prevScale;
				var nextScale = crop.baseScale * nextZoom;

				crop.zoom = nextZoom;
				crop.offsetX = vp.w / 2 - anchorX * nextScale;
				crop.offsetY = vp.h / 2 - anchorY * nextScale;

				cropZoom.value = String(nextZoom);
				constrain();
				paint();
				syncCardArt();
			},
			{ passive: false },
		);
	}

	function bindCropper() {
		if (!cropViewport) return;

		cropPick.addEventListener("click", function () {
			cropFile.click();
		});

		cropFile.addEventListener("change", function () {
			handleFiles(cropFile.files);
			cropFile.value = "";
		});

		/* 拖放图片 */
		["dragenter", "dragover"].forEach(function (type) {
			cropViewport.addEventListener(type, function (event) {
				event.preventDefault();
				cropViewport.classList.add("is-dragover");
			});
		});
		["dragleave", "drop"].forEach(function (type) {
			cropViewport.addEventListener(type, function (event) {
				event.preventDefault();
				cropViewport.classList.remove("is-dragover");
			});
		});
		cropViewport.addEventListener("drop", function (event) {
			handleFiles(event.dataTransfer && event.dataTransfer.files);
		});

		cropZoom.addEventListener("input", function () {
			if (!crop.hasImage) return;
			var vp = viewportSize();
			var prevScale = crop.baseScale * crop.zoom;
			var centerX = (vp.w / 2 - crop.offsetX) / prevScale;
			var centerY = (vp.h / 2 - crop.offsetY) / prevScale;

			crop.zoom = clamp(Number(cropZoom.value) || 1, 1, MAX_ZOOM);
			var nextScale = crop.baseScale * crop.zoom;
			crop.offsetX = vp.w / 2 - centerX * nextScale;
			crop.offsetY = vp.h / 2 - centerY * nextScale;

			constrain();
			paint();
			syncCardArt();
		});

		cropExportBtn.addEventListener("click", exportAvatar);

		bindCropperDrag();
		bindCropperWheel();

		/* 视口尺寸随窗口变化：重算基准缩放并保持构图 */
		if (typeof ResizeObserver === "function") {
			var ro = new ResizeObserver(function () {
				if (!crop.hasImage) return;
				/* 视口尺寸变化时直接重新构图，而不是按比例缩放旧位移 ——
				 * 比例法会把误差累积下来，几次重排之后构图就飘了。 */
				centerCrop();
			});
			ro.observe(cropViewport);
		}
	}

	/* ── 体力输入 ──────────────────────────────────────────────────────
	 * 1. 输入过程中**只收数字与 `/`**（全角数字自动转半角，杂字符直接挡掉）。
	 * 2. **填完对一次格式**（离开输入框、以及提交时各一次）：必须正好两个 `/`，
	 *    也就是三段 `体力/上限/护甲` —— 少了补 `0`，多了截掉多余的段。
	 * 3. **体力大于上限时，上限抬到体力**（`6/4` → `6/6`）—— 引擎本来就会把
	 *    超上限的体力压回上限（引擎 `$update()`），不如这里就填成一致的值。 */
	function bindHpInput() {
		var el = $("f-hp");
		if (!el) return;

		el.addEventListener("input", function () {
			var before = el.value;
			var pos = el.selectionStart;
			var after = sanitizeHpInput(before);

			var parts = after.split("/");
			var raisedTo = 0;
			if (parts.length > 1) {
				var cur = parseInt(parts[0], 10);
				var max = parseInt(parts[1], 10);
				if (cur > 0 && max > 0 && cur > max) {
					var head = parts[0] + "/" + parts[0];
					var tail = parts.slice(2).join("/");
					var raised = tail ? head + "/" + tail : head;
					/* 光标在被动过的那一段之后时，按长度差补回来 */
					var segAt = parts[0].length + 1;
					if (pos > segAt) pos += raised.length - after.length;
					after = raised;
					raisedTo = cur;
				}
			}

			if (after !== before) {
				el.value = after;
				var at = clamp(pos, 0, after.length);
				el.setSelectionRange(at, at);
				/* 这一改动了用户填的数（上限被抬到体力），必须说一声 ——
				 * 静默改数是最招人烦的一种「帮忙」，用户还会以为自己打错了。 */
				if (raisedTo) {
					announce(
						"体力比上限大，已把上限抬到 " + raisedTo + "（不然游戏会把体力压回上限）。" +
							"想开局更耐打，用第三个数写护甲，例：4/4/2。",
					);
				}
			}
			renderCard();
		});

		/* 填完就把格式对齐：正好两个斜杠、三段。补过了就说一声，
		 * 免得用户没注意到框里的值被改过。 */
		el.addEventListener("blur", function () {
			var fixed = hpFieldText(el.value);
			if (fixed === el.value) return;
			el.value = fixed;
			renderCard();
			announce("体力按「体力/上限/护甲」补成 " + fixed + " 了。");
		});
	}

	/* ── 表单绑定 ──────────────────────────────────────────────────────── */
	function bindForm() {
		var form = $("hero-form");
		if (!form) return;

		/* 体力框单独处理（护栏 + 自动重绘），见 bindHpInput */
		["f-name", "f-title"].forEach(function (id) {
			var el = $(id);
			if (el) el.addEventListener("input", renderCard);
		});

		form.querySelectorAll('input[name="group"]').forEach(function (radio) {
			radio.addEventListener("change", function () {
				if (radio.checked) renderGroup(radio.value);
			});
		});

		/* 清空（reset）：浏览器的 reset 只还原 radio 的 checked 与输入框的值，
		 * 不会碰我们自己加上去的 is-active 高亮 —— 于是出现「预设重新选中、
		 * 自定义框还亮着」，看上去像同时选了两个。这里一并清掉。 */
		form.addEventListener("reset", function () {
			window.setTimeout(function () {
				Array.prototype.forEach.call(
					document.querySelectorAll(".choice--custom"),
					function (box) {
						box.classList.remove("is-active");
						var boxInput = box.querySelector(".choice__input");
						if (boxInput) boxInput.value = "";
					},
				);
				/* 焦点若还留在自定义框里，blur 会再把高亮加回来，先移开 */
				if (document.activeElement && document.activeElement.blur) {
					document.activeElement.blur();
				}

				/* 技能列表挂在 <form> 之外（动态生成的），浏览器 reset 够不着它，
				 * 必须自己重建 —— 否则"清空"之后技能还留着，包括从已有扩展读进来的。
				 * addSkill 会顺带把第四步的技能块也重建，台词与配音一起清掉。 */
				var skillListEl = $("skill-list");
				if (skillListEl) {
					skillListEl.textContent = "";
					addSkill("", "", true); /* 恢复两张「示例位」 */
					addSkill("", "", true, null, true);
				}

				/* 第四步整个也在 <form> 之外：阵亡台词、皮肤列表都要手动清，
				 * 否则「清空」之后它们还留着，跟空表单一起交出去就成了脏数据。 */
				resetMore();

				/* 「选择扩展包」那个框复位，并让武将下拉回到"请先选扩展"。
				   注意 #f-ext-existing 现在是包着菜单的 div，不是下拉框 ——
				   以前当 select 清 .value 是无效动作，改为一并收起菜单。 */
				setPickerSummary("");
				closePicker();
				var nameSel = $("f-name-existing");
				if (nameSel) {
					nameSel.value = "";
					nameSel.innerHTML = '<option value="">— 请先选择扩展 —</option>';
				}
				existingChars = [];
				existingExtName = "";
				uploadedRoot = "";

				/* 模式复位到「新建扩展」，控件显示状态一起复位 */
				var newRadio = document.querySelector('input[name="extMode"][value="new"]');
				if (newRadio) newRadio.checked = true;
				applyExtMode("new");

				/* 立绘也清 —— 清空就该是彻底清空 */
				resetAvatar();

				/* 「识别卡面」面板收起。挂在 reset 上而不是按钮的 click 上：
				 * 「清空」的语义就是 reset，这样程序化 reset 也表现一致；
				 * 入口小按钮的文案与 aria 一并复位。 */
				setPanelOpen(false);

				/* 官方包选择区也收起来并清空 —— 它是"往外读"的那一头 */
				officialPick = null;
				var offWrap = $("official-picker");
				if (offWrap) offWrap.hidden = true;
				var offPack = $("official-pack");
				if (offPack) offPack.innerHTML = '<option value="">— 读取中 —</option>';
				var offChar = $("official-char");
				if (offChar) offChar.innerHTML = '<option value="">— 先选包 —</option>';
				var offSearch = $("official-search");
				if (offSearch) offSearch.value = "";

				/* 工作区扩展选择区同理（它是「修改已有」的另一条来路） */
				var wsWrap = $("workspace-picker");
				if (wsWrap) wsWrap.hidden = true;
				var wsExt = $("workspace-ext");
				if (wsExt) wsExt.innerHTML = '<option value="">— 读取中 —</option>';
				var wsChar = $("workspace-char");
				if (wsChar) wsChar.innerHTML = '<option value="">— 先选扩展 —</option>';

				renderGroup("wei");
				renderCard();
			}, 0);
		});

		/* 表单里的回车一律吞掉，且不提供键盘提交：
		 * 单行输入框上的裸回车是浏览器默认的提交手势，但用户在填表途中按回车
		 * 绝不是"我要提交"的意思（曾经因此把半成品需求发出去过）。
		 * 提交只认鼠标点按钮 —— 快捷键也一并去掉，免得误触。 */
		form.addEventListener("keydown", function (event) {
			if (event.key !== "Enter") return;

			var el = event.target;
			/* 描述框里回车是换行，放行 */
			if (el && el.tagName === "TEXTAREA") return;

			event.preventDefault();
		});

		/* 主路径：交给对话里的 AI（落成 JSON，回到对话窗口继续） */
		form.addEventListener("submit", function (event) {
			event.preventDefault();
			handoffToAgent();
		});

	}

	/* ── 状态行（role=status，读屏可播报） ─────────────────────────────── */
	function announce(message) {
		var host = $("form-status");
		if (host) host.textContent = message;
	}

	/* ── 启动 ──────────────────────────────────────────────────────────── */
	function init() {
		playEntrance();
		renderGroup("wei");
		/* 起手给两张「示例位」技能卡，且都展开不折叠 */
		addSkill("", "", true);
		addSkill("", "", true, null, true);

		/* 一个模块初始化失败，不该拖垮其他模块。
		 * 真实教训：bindEditMode 里引用了一个已删除的变量，抛异常后
		 * 后面的模块全部没启动 —— 表现是「按钮没反应」，
		 * 而控制台之外看不出哪里坏了。这里逐个隔离。 */
		[
			["表单", bindForm],
			["体力输入", bindHpInput],
			["立绘裁剪", bindCropper],
			["扩展目标", bindExtensionTarget],
			["修改已有", bindEditMode],
			["自定义势力/性别", bindCustomChoices],
			["更多拓展", bindMore],
			["卡面识别", bindCardImport],
		].forEach(function (pair) {
			try {
				pair[1]();
			} catch (err) {
				console.error("[init] " + pair[0] + " 初始化失败：", err);
				try {
					announce(pair[0] + "没加载成功，刷新页面再试一次。");
				} catch (_) {
					/* 状态行本身出错就忽略 */
				}
			}
		});
	}

	/* 把当前裁剪结果导出成头像 dataURL —— 随表单一起交给 AI。
	 * 「没有立绘」是常见的漏项，交给上层去提醒用户。 */
	function exportAvatarDataUrl() {
		if (!crop.hasImage) return null;
		var vp = viewportSize();
		var scale = crop.baseScale * crop.zoom;
		var canvas = document.createElement("canvas");
		canvas.width = AVATAR_W;
		canvas.height = AVATAR_H;
		var ctx = canvas.getContext("2d");
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(
			cropImage,
			-crop.offsetX / scale,
			-crop.offsetY / scale,
			vp.w / scale,
			vp.h / scale,
			0,
			0,
			AVATAR_W,
			AVATAR_H,
		);
		return canvas.toDataURL("image/jpeg", 0.92);
	}

	function collectForm() {
		var groupRadio = document.querySelector('input[name="group"]:checked');
		var sexRadio = document.querySelector('input[name="sex"]:checked');
		var modeRadio = document.querySelector('input[name="extMode"]:checked');
		var groupCustom = fieldValue("f-group-custom");

		var payload = {
			extMode: modeRadio ? modeRadio.value : "new",
			extName: fieldValue("f-ext"),
			name: fieldValue("f-name"),
			title: fieldValue("f-title"),
			/* 自定义势力非空时 group 必须留空、以 groupCustom 为准 ——
			 * 否则 AI 会照着 group 里的内置值写，用户自定义的势力被丢掉 */
			group: groupCustom ? "" : groupRadio ? groupRadio.value : "wei",
			groupCustom: groupCustom,
			/* 性别只有官方那四个值：male / female / double / none */
			sex: sexRadio ? sexRadio.value : "male",
			hp: hpFieldText(fieldValue("f-hp")),
			skills: getSkills(),
			/* 扩展包介绍（可选）：写进 info.json 的 `intro`，是**整包**级别的说明，不是某个武将的。
			 * 引擎读它见 `init/import.js`；显示在扩展菜单里，
			 * 渲染走 `ui.create.div(".text", intro)` —— 所以**支持 HTML 标签**。 */
		intro: fieldValue("f-intro").trim(),
		avatar: exportAvatarDataUrl(),
		/* 阵亡台词：一行一句，可以有多句。
		 * 关键约束 —— 想让多句都生效，角色上不能只写 `dieAudios: true`，
		 * 那只会读第 1 句（键 `#<角色id>:die`，官方 voices.js 里的写法）。
		 * 要写**数字**：`dieAudios: <句数>` 时引擎才按
		 * `#<角色id>1:die`、`#<角色id>2:die` … 逐条去取
		 * （展示点见规范 8.1）。 */
		dieLines: splitLines(dieInput ? dieInput.value : ""),
	};

	/* 国战：归属 + 多势力。平时势力（payload.group）不动 —— 这里只管国战里的归属。
	 * 空值不进 payload（理由同 intro：不要让 AI 清除已写的国战字段）。 */
	var gz = gzGroupSel ? gzGroupSel.value : "";
	if (gz) payload.guozhanGroup = gz;
	var dgs = gzGroups
		? Array.prototype.map.call(gzGroups.querySelectorAll("input:checked"), function (box) {
				return box.value;
			})
		: [];
	if (dgs.length) payload.doubleGroups = dgs;

	/* 宗族：payload.clans 是数组（引擎 clans 字段就是数组，可归属多个）。
	 * 空值不落键，理由同 intro。 */
	var clan = clanInput ? clanInput.value.trim() : "";
	if (clan) payload.clans = [clan];

	/* 武将列传：详情页的生平（lib.characterIntro）。
	 * 空值不落键 —— 留空后在对话里说一声，AI 会按史实代写。 */
	var bio = bioInput ? bioInput.value.trim() : "";
	if (bio) payload.characterIntro = bio;

	/* 资料页四字段 + 选将包名：整包级 KV。
	 * 与 intro 同一条规矩 —— **空值不进 payload**，否则「加入已有」时
	 * 用户没填作者，AI 会把人家扩展原来的作者清掉。 */
	var INFO_FIELDS = [
		["author", "f-author"],
		["version", "f-version"],
		["packDisplayName", "f-packname"],
	];
	INFO_FIELDS.forEach(function (pair) {
		var v = fieldValue(pair[1]).trim();
		if (v) payload[pair[0]] = v;
	});

	/* 上传过的扩展留在工作区里：把落点交给 AI ——
	 * 「加入已有」要往里追加武将，「修改已有」要就地改字段。
	 * 没有它，上传来的包对 AI 来说等于不存在（审计 2026-10-10 的断点）。 */
	if (uploadedRoot && (payload.extMode === "existing" || payload.extMode === "edit")) {
		payload.uploadPath = uploadedRoot;
	}

	/* 官方包当模板：把来源一起交给 AI。它据此知道「这是官方武将的模板，只能另建
	 * 扩展」—— 官方武将不能改（游戏本体只读），这条红线就靠这个标记兜住。 */
	if (officialPick && officialPick.charId) {
		payload.officialTemplate = {
			pack: officialPick.pack,
			packLabel: officialPick.label || "",
			characterId: officialPick.charId,
			characterName: officialPick.name || "",
		};
	}

	/* 修改已有：把「改的是哪个扩展的哪个武将」和读出来的原值一起交出去。
	 * AI 拿到 original 就能算出用户改了哪些字段，只改那几处 ——
	 * 整块重写容易丢掉原文件里的其他内容（别的武将、卡片、注释）。 */
	if (payload.extMode === "edit" && existingExtName && pickedCharId && existingOriginal) {
		payload.editTarget = {
			extName: existingExtName,
			characterId: pickedCharId,
			source: existingSource || "unknown",
			original: existingOriginal,
		};
	}

	return payload;
}

	/* ── 主路径：交给对话里的 AI ─────────────────────────────────────────
	 * 网页只负责收集，落成 `<工作区>/.diy-workshop/latest-request.json`；
	 * 用户回到 AI 对话窗口后，AI 读这份文件接着做 —— 歧义也在那边用弹窗问，
	 * 不在网页里来回问答。 */
	function handoffToAgent() {
		/* 页面若被双击直接打开（file://），提交是发不出去的 —— 先拦下来讲清楚 */
		if (location.protocol === "file:") {
			announce(
				"这个页面要经由本地服务打开。先运行 node <skill目录>/workshop/server/server.mjs，" +
					"再打开它给出的网址。",
			);
			return;
		}

		var payload = collectForm();
		if (!payload.extName) {
			announce("还没填扩展名。新建就起个名字，加入已有就选一下扩展的 zip。");
			return;
		}
		if (!payload.name) {
			announce("武将名还是空的，至少给个名字。");
			return;
		}

		/* 体力填得比上限大：引擎照样收，但玩家一初始化就会被 `$update()`
		 * 压回上限（`$update()` 里 `hp >= maxHp → hp = maxHp`，
		 * 见 `$update()`）。不拦住提交 —— 用户可能就是想这么填 —— 但要说一声，
		 * 并告诉他真正想要的效果该用第三个数字（护甲）。
		 *
		 * 注意：正常流程走不到这里 —— `hpFieldText()` 早就把上限抬到体力了
		 * （`bindHpInput` 输入时也会抬，并当场提示用户），所以 payload 里
		 * 不可能出现 current > max。这段是防「hp 从别的路径进来」的兜底。 */
		var hpPair = parseHpText(payload.hp);
		var hpOverMax = hpPair.max > 0 && hpPair.current > hpPair.max;

		announce("正在把设定交到工作区…");

		/* 配音与皮肤图先单独上传（mp3 太大、图片是 base64，塞进 handoff 的 JSON 都会撑爆它）。
		 * 全部落盘、路径回填进 payload 之后，才发 handoff。 */
		uploadAudioForSkills(payload)
			.then(function () {
				return uploadSkins(payload);
			})
			.then(function () {
				sendHandoff(payload, hpOverMax);
			})
			.catch(function (err) {
				announce("素材上传失败：" + err.message + "（本地服务还在跑吗？）");
			});
	}

	/* 最后一步：把整份 payload 落成工作区里的 latest-request.json。 */
	function sendHandoff(payload, hpOverMax) {
		fetch("/api/handoff", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		})
			.then(function (res) {
				return res.json().then(function (data) {
					/* 重名冲突单独处理：要让用户明确知道下一步怎么做 */
					if (res.status === 409 && data.conflict) {
						var err = new Error(data.error);
						err.conflict = data.conflict;
						err.hint = data.hint;
						throw err;
					}
					if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
					return data;
				});
			})
			.then(function (data) {
				var done = "已提交。回到 AI 对话窗口说一声，AI 就会接着做。";
				if (hpOverMax) {
					done +=
						" 提醒：体力填得比上限大 —— 进游戏会被压回上限；" +
						"想开局更耐打，用三个数写护甲（例：4/4/2）。";
				}
				announce(done);
			})
			.catch(function (err) {
				if (err.conflict) {
					announce(
						"扩展「" + err.conflict.name + "」已经存在。" +
							"要么把「扩展到」改成「加入已有」来追加武将，要么换个扩展名。",
					);
					return;
				}
				announce("提交失败：" + err.message + "（本地服务还在跑吗？）");
			});
	}


	/* 扩展目标：新建 / 加入已有。
	 * 页面本身不落盘，"落到哪个扩展"是交给 AI 执行时的指令，
	 * 所以这里只负责把两种模式的语义讲清楚。 */
	/* ── 修改已有：选扩展 → 选武将 → 自动填表 ──────────────────────────
	 * 只读不写：把已有扩展里解析出的武将信息填回表单，用户改完再提交。
	 * 立绘从扩展目录读原图，走与手动选图相同的 loadImageSource。 */
	var existingChars = [];
	var existingExtName = "";
	/* 修改已有：记住「选中的是哪个武将」与「读出来的原值」，
	 * 提交时一并带上，让 AI 能只改用户动过的字段，而不是整块重写文件。 */
	var pickedCharId = "";
	var existingSource = "";        // installed | upload
	var existingOriginal = null;    // 读出来的原始数据快照
	/* 上传的扩展在工作区里的落点（服务端解压后保留，不删）——
	 * 「加入已有」往这里追加武将，「修改已有」在这里就地改字段 */
	var uploadedRoot = "";
	/* 官方包当模板时选中的包与武将（null = 没用这个入口）。
	 * 它**不是**「已有的扩展」—— 官方武将只读，改完只能另建扩展，
	 * 所以扩展名留空、也不生成 editTarget（那个会指向游戏本体）。 */
	var officialPick = null;
	/* 「从工作区选择」拿到的扩展清单（含 path，选中后作为 uploadPath） */
	var workspaceExts = [];

	function bindEditMode() {
		var modeRadios = document.querySelectorAll('input[name="extMode"]');
		if (!modeRadios.length) return;

		Array.prototype.forEach.call(modeRadios, function (radio) {
			radio.addEventListener("change", function () {
				if (radio.checked) applyExtMode(radio.value);
			});
		});


		var nameSelect = $("f-name-existing");
		if (nameSelect) {
			nameSelect.addEventListener("change", function () {
				applyCharacter(nameSelect.value);
			});
		}

		bindEditSource();
		applyExtMode("new");
	}

	/* ── 修改已有：选扩展包（文件夹 / 压缩包）→ 解析 → 填表 ──────────────
	 * 压缩包交给服务端解压；文件夹则把文件逐个传上去。
	 * 解析在服务端临时目录里做，读完即删，不往工作区落垃圾。 */
	function bindEditSource() {
		var pickDir = $("edit-pick-dir");
		var pickZip = $("edit-pick-zip");
		var dirInput = $("edit-dir-input");
		var zipInput = $("edit-zip-input");
		if (pickDir && dirInput) {
			pickDir.addEventListener("click", function () { dirInput.click(); });
			dirInput.addEventListener("change", function () {
				/* 选完就收起菜单：里面那两项是一次性动作，
				   不收起会一直盖住下面的「选择武将」下拉 */
				closePicker();
				handleDirPick(Array.prototype.slice.call(dirInput.files || []));
				dirInput.value = "";
			});
		}

		if (pickZip && zipInput) {
			pickZip.addEventListener("click", function () { zipInput.click(); });
			zipInput.addEventListener("change", function () {
				closePicker();
				handleZipPick(zipInput.files && zipInput.files[0]);
				zipInput.value = "";
			});
		}

		bindOfficialPicker();
		bindWorkspacePicker();
		bindSkinCrop();
	}

	/* ── 官方包：当模板用（官方武将只读，改完落成自己的扩展）─────────────────
	 * 与「选文件夹 / 选 zip」的区别：这里不读用户上传的东西，而是让服务端
	 * 去游戏目录里读官方包 —— 上传那条路走不通（一个包几百 KB、浏览器还得
	 * 转 base64，文件数也超限）。服务端返回的形状与扩展一致，所以选中之后
	 * 直接复用 applyCharacter 那套回填（含立绘送进裁剪器）。 */
	function bindOfficialPicker() {
		var openBtn = $("edit-pick-official");
		var wrap = $("official-picker");
		var packSel = $("official-pack");
		var charSel = $("official-char");
		var search = $("official-search");
		if (!openBtn || !wrap || !packSel || !charSel) return;

		openBtn.addEventListener("click", function () {
			closePicker();
			wrap.hidden = false;
			loadOfficialPacks();
		});

		packSel.addEventListener("change", function () {
			var pack = packSel.value;
			officialPick = null;
			if (!pack) {
				charSel.innerHTML = '<option value="">— 先选包 —</option>';
				return;
			}
			charSel.innerHTML = '<option value="">— 读取中 —</option>';
			fetch("/api/official-characters?pack=" + encodeURIComponent(pack), { cache: "no-store" })
				.then(function (r) {
					return r.json().then(function (d) {
						if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
						return d;
					});
				})
				.then(function (data) {
					existingChars = data.characters || [];
					/* 官方武将不当「已有扩展」处理：扩展名留空让用户自己起，
					   也正因如此不会生成 editTarget */
					existingExtName = "";
					existingSource = "official";
					officialPick = { pack: data.name, label: data.label || data.name, charId: "", name: "" };
					fillOfficialChars();
					if (search) search.value = "";
					announce(
						"官方包「" + (data.label || data.name) + "」读出 " + existingChars.length +
							" 个武将，挑一个当模板 —— 改完会做成你自己的扩展。",
					);
				})
				.catch(function (err) {
					charSel.innerHTML = '<option value="">读取失败：' + escapeText(err.message) + "</option>";
				});
		});

		charSel.addEventListener("change", function () {
			var id = charSel.value;
			if (!id) return;
			/* 复用「修改已有」那套回填（名字/称号/势力/性别/体力/技能/立绘） */
			applyCharacter(id);
			if (officialPick) {
				officialPick.charId = id;
				var picked = existingChars.filter(function (c) { return c.id === id; })[0];
				officialPick.name = picked ? picked.name : "";
				announce(
					"已按官方武将「" + (officialPick.name || id) +
						"」填好 —— 那是模板，改完做成你自己的扩展，游戏里那个原武将不受影响。",
				);
			}
		});

		/* 搜索只过滤下拉里的候选项，不动已经选中的值。
		 * 用**事件委托**挂在容器上，不直接绑输入框 —— 容器不会被动重建，
		 * 少一层"引用是否还指着当前那个元素"的赌注。 */
		wrap.addEventListener("input", function (e) {
			var t = e.target;
			if (t && t.id === "official-search") fillOfficialChars(t.value);
		});
	}

	/* ── 工作区里已有的扩展：不用找 zip，直接从目录读 ────────────────────────
	 * 「修改已有」要的就地改写落点（`uploadPath`）就是这个扩展的目录。
	 * 与上传的唯一区别是"东西从哪来"：这条路不走上传，直接问服务端要。
	 *
	 * 只列 `origin` 为「工作区」的 —— 游戏包里装的扩展是只读的，
	 * 拿它当落点就等于往游戏本体里写（红线），所以不出现在这里。
	 * （想改游戏里那份，先手工复制进工作区。） */
	function bindWorkspacePicker() {
		var openBtn = $("edit-pick-workspace");
		var wrap = $("workspace-picker");
		var extSel = $("workspace-ext");
		var charSel = $("workspace-char");
		if (!openBtn || !wrap || !extSel || !charSel) return;

		openBtn.addEventListener("click", function () {
			closePicker();
			wrap.hidden = false;
			loadWorkspaceExtensions();
		});

		extSel.addEventListener("change", function () {
			var name = extSel.value;
			if (!name) {
				charSel.innerHTML = '<option value="">— 先选扩展 —</option>';
				return;
			}
			var item = workspaceExts.filter(function (x) { return x.name === name; })[0] || null;
			if (!item) {
				charSel.innerHTML = '<option value="">— 找不到该扩展 —</option>';
				return;
			}

			/* 游戏包里那份是只读的：先让服务端复制成工作区副本，再改副本。
			 * 落点（uploadedRoot）一律取**复制后**的路径 —— 绝不能指到游戏本体。 */
			var ready;
			if (item.origin === "工作区") {
				ready = Promise.resolve({ ok: true, name: name, path: item.path, copied: false });
			} else {
				charSel.innerHTML = '<option value="">— 正在复制到工作区 —</option>';
				ready = fetch("/api/import-extension", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: name }),
				}).then(function (r) {
					return r.json().then(function (d) {
						if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
						return d;
					});
				});
			}

			var copied = false;
			ready
				.then(function (info) {
					copied = !!info.copied;
					uploadedRoot = info.path || "";
					existingExtName = info.name || name;
					existingSource = "installed";
					/* 扩展名写进表单 —— 与上传那条路（handleZipPick）保持一致 */
					var extInput = $("f-ext");
					if (extInput) extInput.value = existingExtName;
					setPickerSummary(existingExtName);
					if (copied) {
						announce(
							"游戏包里那份是只读的，已复制成工作区副本「" + existingExtName +
								"」，改动会落在副本上。",
						);
					}
					return fetch("/api/extension-characters?name=" + encodeURIComponent(name), {
						cache: "no-store",
					});
				})
				.then(function (r) {
					return r.json().then(function (d) {
						if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
						return d;
					});
				})
				.then(function (data) {
					existingChars = data.characters || [];
					/* 扩展包介绍是整包级的，单独回填一次 */
					if (data.intro) setFieldValue("f-intro", data.intro);
					fillWorkspaceChars();
					announce(
						"已读入「" + existingExtName + "」的 " + existingChars.length + " 个武将 —— 挑一个改，改动会写回" +
							(copied ? "工作区里的副本。" : "该目录。"),
					);
				})
				.catch(function (err) {
					uploadedRoot = "";
					charSel.innerHTML = '<option value="">读取失败：' + escapeText(err.message) + "</option>";
				});
		});

		charSel.addEventListener("change", function () {
			var id = charSel.value;
			if (!id) return;
			/* 复用「修改已有」那套回填（名字/称号/势力/体力/技能/立绘） */
			applyCharacter(id);
		});
	}

	function loadWorkspaceExtensions() {
		var extSel = $("workspace-ext");
		if (!extSel) return;
		extSel.innerHTML = '<option value="">— 读取中 —</option>';
		fetch("/api/extensions", { cache: "no-store" })
			.then(function (r) { return r.json(); })
			.then(function (data) {
				if (!data.ok) throw new Error(data.error || "读不到扩展列表");
				/* 全都列出来：工作区里的直接改；游戏包里那份是只读的，
				 * 选中后先复制成工作区副本（选项上标出来，别让人以为能就地改）。 */
				workspaceExts = (data.extensions || []).filter(function (x) { return x.path; });
				if (!workspaceExts.length) {
					extSel.innerHTML = '<option value="">— 没找到扩展 —</option>';
					return;
				}
				var opts = ['<option value="">— 选择扩展 —</option>'];
				workspaceExts.forEach(function (x) {
					var tag = x.origin === "工作区" ? "" : "（游戏包里，会复制一份到工作区）";
					opts.push(
						'<option value="' + escapeAttr(x.name) + '">' +
							escapeText(x.name) + tag + "</option>",
					);
				});
				extSel.innerHTML = opts.join("");
			})
			.catch(function (err) {
				extSel.innerHTML = '<option value="">读取失败：' + escapeText(err.message) + "</option>";
			});
	}

	/* 铺工作区扩展的武将下拉 */
	function fillWorkspaceChars() {
		var sel = $("workspace-char");
		if (!sel) return;
		/* 空包要说清楚，别只给一句"请选择武将"让人发呆 */
		var head = existingChars.length
			? "— 请选择武将 —"
			: "— 这个扩展里没读出武将（写法特殊的话得手动填）—";
		var opts = ['<option value="">' + head + "</option>"];
		existingChars.forEach(function (c) {
			opts.push(
				'<option value="' + escapeAttr(c.id) + '">' +
					escapeText(c.name) + " · " + escapeText(c.id) + "</option>",
			);
		});
		sel.innerHTML = opts.join("");
	}

	function loadOfficialPacks() {
		var packSel = $("official-pack");
		if (!packSel) return;
		packSel.innerHTML = '<option value="">— 读取中 —</option>';
		fetch("/api/official-packs", { cache: "no-store" })
			.then(function (r) { return r.json(); })
			.then(function (data) {
				if (!data.ok) throw new Error(data.error || "读不到官方包");
				var packs = data.packs || [];
				if (!packs.length) {
					packSel.innerHTML = '<option value="">— 没找到官方包（工作区里有装好游戏吗？）—</option>';
					return;
				}
				var opts = ['<option value="">— 选择官方包 —</option>'];
				packs.forEach(function (p) {
					opts.push(
						'<option value="' + escapeAttr(p.name) + '">' +
							escapeText(p.label || p.name) + "（" + p.count + " 人）</option>",
					);
				});
				packSel.innerHTML = opts.join("");
			})
			.catch(function (err) {
				packSel.innerHTML = '<option value="">读取失败：' + escapeText(err.message) + "</option>";
			});
	}

	/* 铺官方武将下拉；keyword 非空时按名字 / id 过滤 */
	function fillOfficialChars(keyword) {
		var sel = $("official-char");
		if (!sel) return;
		var kw = String(keyword || "").trim().toLowerCase();
		var list = existingChars.filter(function (c) {
			if (!kw) return true;
			return (
				String(c.name || "").toLowerCase().indexOf(kw) >= 0 ||
				String(c.id || "").toLowerCase().indexOf(kw) >= 0
			);
		});
		var keep = sel.value;
		var opts = ['<option value="">— ' + (kw ? "命中 " + list.length + " 个" : "请选择武将") + ' —</option>'];
		list.forEach(function (c) {
			opts.push(
				'<option value="' + escapeAttr(c.id) + '">' +
					escapeText(c.name) + " · " + escapeText(c.id) + "</option>",
			);
		});
		sel.innerHTML = opts.join("");
		if (keep && list.some(function (c) { return c.id === keep; })) sel.value = keep;
	}

	/* 收起「选择扩展包」菜单（选完文件 / 清空表单时用）。
	 * 取消文件选择框不会触发 change，所以取消时菜单会留着 —— 那是对的。 */
	function closePicker() {
		var picker = document.querySelector("#f-ext-existing details.picker");
		if (picker && picker.open) picker.open = false;
	}

	/* 选文件夹：逐个文件转 base64 上传 */
	function handleDirPick(files) {
		if (!files.length) return;
		if (files.length > 800) {
			announce("这个文件夹文件太多（" + files.length + " 个），建议先压成 zip 再选。");
			return;
		}
		announce("正在读取文件夹（" + files.length + " 个文件）…");

		Promise.all(
			files.map(function (f) {
				return new Promise(function (resolve) {
					var reader = new FileReader();
					reader.onload = function () {
						var s = String(reader.result);
						resolve({
							path: f.webkitRelativePath || f.name,
							data: s.slice(s.indexOf(",") + 1),
						});
					};
					reader.onerror = function () { resolve(null); };
					reader.readAsDataURL(f);
				});
			}),
		).then(function (list) {
			var top = (files[0].webkitRelativePath || "").split("/")[0] || "扩展";
			uploadForRead({ kind: "dir", name: top, files: list.filter(Boolean) });
		});
	}

	/* 选压缩包：整个文件转 base64，服务端解压。
	 * purpose 为 "existing"（加入已有）时只取扩展名，不要求选武将。 */
	function handleZipPick(file, purpose) {
		if (!file) return;
		announce("正在上传压缩包…");
		var reader = new FileReader();
		reader.onload = function () {
			var s = String(reader.result);
			uploadForRead(
				{ kind: "zip", name: file.name, data: s.slice(s.indexOf(",") + 1) },
				purpose,
			);
		};
		reader.readAsDataURL(file);
	}

	function uploadForRead(payload, purpose) {
		fetch("/api/read-upload", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		})
			.then(function (r) {
				return r.json().then(function (d) {
					if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
					return d;
				});
			})
			.then(function (data) {
				existingChars = data.characters || [];
				existingExtName = data.name || "";
				existingSource = "upload";
				/* 服务端把包留在工作区里了，这个路径要一起交给 AI ——
				 * 「加入已有」靠它追加、「修改已有」靠它就地把字段改回去 */
				uploadedRoot = data.root || "";
				/* 扩展包介绍是**整包**级的：读出来填上，让用户看到这个包现在写的是什么、要改就改 */
				setFieldValue("f-intro", data.intro || "");
				/* 选中之后，「选择扩展包」这个框里显示包名 —— 否则看不出选的是什么 */
				setPickerSummary(existingExtName);

				/* 加入已有：只要扩展名（以包内 extension.js 的 name 为准），
				 * 不要求选武将 —— 新武将是往里追加的 */
				if (purpose === "existing") {
					var extInput = $("f-ext");
					if (extInput) extInput.value = existingExtName;
					var pickBtn = $("ext-pick");
					if (pickBtn) pickBtn.textContent = "换一个";
					announce("已解析扩展「" + existingExtName + "」，新武将会追加进去。");
					return;
				}

				fillCharacterSelect();
				if (!existingChars.length) {
					announce(data.unreadable || "这个包里没解析出武将，可以手动填。");
					return;
				}
				announce("解析出 " + existingChars.length + " 个武将，选一个开始改。");
			})
			.catch(function (err) {
				announce("读取失败：" + err.message);
			});
	}

	/* 把「选择扩展包」那个框的文案换成选中的包名 */
	function setPickerSummary(text) {
		var summary = document.querySelector("#f-ext-existing summary");
		if (summary) summary.textContent = text || "选择扩展包";
	}

	/* 把 existingChars 铺进武将下拉 */
	function fillCharacterSelect() {
		var sel = $("f-name-existing");
		if (!sel) return;
		if (!existingChars.length) {
			sel.innerHTML = '<option value="">— 这个包没解析出武将 —</option>';
			return;
		}
		var opts = ['<option value="">— 请选择武将 —</option>'];
		existingChars.forEach(function (c) {
			opts.push(
				'<option value="' + escapeAttr(c.id) + '">' +
					escapeText(c.name) + " · " + escapeText(c.id) +
					"</option>",
			);
		});
		sel.innerHTML = opts.join("");
	}

	/* 按模式切换各块：修改已有把「扩展名 / 武将名」换成下拉 */
	function applyExtMode(mode) {
		var extInput = $("f-ext");
		var extSelect = $("f-ext-existing");
		var extPick = $("ext-pick");
		var extLabel = $("ext-label");
		var extHint = $("ext-hint");
		var nameInput = $("f-name");
		var nameSelect = $("f-name-existing");
		var nameLabel = $("name-label");
		var nameHint = $("name-hint");

		if (mode === "edit") {
			if (extInput) extInput.hidden = true;
			if (extSelect) extSelect.hidden = false;
			if (extPick) extPick.hidden = true;
			if (extLabel) extLabel.textContent = "选择扩展";
			if (extHint) extHint.textContent = "推荐先手动解压，再选文件夹。直接选 zip 由脚本自动解压，极少数非常规压缩包可能解不开。";
			if (nameInput) nameInput.hidden = true;
			if (nameSelect) nameSelect.hidden = false;
			if (nameLabel) nameLabel.textContent = "选择武将";
			if (nameHint) nameHint.textContent = "选好后会自动填入称号、势力、性别、体力、技能与立绘。";
			return;
		}

		if (extInput) extInput.hidden = false;
		if (extSelect) extSelect.hidden = true;
		if (nameInput) nameInput.hidden = false;
		if (nameSelect) nameSelect.hidden = true;
		if (nameLabel) nameLabel.textContent = "武将名";
		if (nameHint) nameHint.innerHTML = "显示名，会写入 <code>translate</code>";

		if (mode === "existing") {
			/* 加入已有：扩展名来自 zip，不让手打，框里只显示选中的文件名 */
			if (extPick) extPick.hidden = false;
			if (extInput) {
				extInput.readOnly = true;
				extInput.placeholder = "点右侧按钮选择 zip";
				extInput.value = "";
			}
			if (extLabel) extLabel.textContent = "扩展 zip";
			if (extHint) extHint.textContent = "选一个扩展的 zip，新武将会追加进去，旧内容不动。";
		} else {
			if (extPick) extPick.hidden = true;
			if (extInput) {
				extInput.readOnly = false;
				extInput.placeholder = "例如：我的扩展";
				extInput.value = "";
			}
			if (extLabel) extLabel.textContent = "扩展名";
			if (extHint) extHint.textContent = "文件夹名即扩展名。新建的包连同 info.json / extension.js / 头像一起生成。";
		}
	}

	function loadCharacters(extName) {
		var sel = $("f-name-existing");
		if (!sel) return;
		existingExtName = extName || "";
		existingChars = [];

		if (!extName) {
			sel.innerHTML = '<option value="">— 请先选择扩展 —</option>';
			return;
		}
		sel.innerHTML = '<option value="">— 读取中 —</option>';

		fetch("/api/extension-characters?name=" + encodeURIComponent(extName), { cache: "no-store" })
			.then(function (r) { return r.json(); })
			.then(function (data) {
				if (!data.ok) throw new Error(data.error || "读不到武将");
				existingChars = data.characters || [];
				existingSource = "installed";
				/* 扩展包介绍是**整包**级的，跟读出来的武将没关系 —— 单独填一次 */
				setFieldValue("f-intro", data.intro || "");
				setPickerSummary(existingExtName);
				if (sel) sel.setAttribute("data-count", String(existingChars.length));
				fillCharacterSelect();
			})
			.catch(function (err) {
				sel.innerHTML = '<option value="">读取失败：' + escapeText(err.message) + "</option>";
			});
	}

	/* 把选中的武将填回表单 */
	function applyCharacter(charId) {
		if (!charId) {
			pickedCharId = "";
			existingOriginal = null;
			return;
		}
		var picked = existingChars.filter(function (x) { return x.id === charId; })[0];
		if (!picked) return;

		pickedCharId = charId;
		/* 快照原值：AI 据此判断哪些字段被改过 */
		existingOriginal = JSON.parse(JSON.stringify(picked));

		var extInput = $("f-ext");
		if (extInput) extInput.value = existingExtName;

		setFieldValue("f-name", picked.name);
		setFieldValue("f-title", picked.title);

		/* 势力：预设能对上就点预设，否则写进自定义框 */
		var groupRadio = document.querySelector('input[name="group"][value="' + picked.group + '"]');
		var groupCustom = $("f-group-custom");
		if (groupRadio) {
			groupRadio.checked = true;
			groupRadio.dispatchEvent(new Event("change", { bubbles: true }));
			if (groupCustom) groupCustom.value = "";
		} else if (groupCustom) {
			groupCustom.value = picked.group;
			groupCustom.dispatchEvent(new Event("input", { bubbles: true }));
		}

		/* 性别：只有官方那四个值。读回来的值不在其中时（老扩展里写了别的字串），
		 * 按男性填并说一声 —— 引擎的 hasSex() 对不认识的性别一律判 false，
		 * 那种武将等于「不男不女」，不提醒用户会一头雾水。 */
		var sexRadio = document.querySelector('input[name="sex"][value="' + picked.sex + '"]');
		var sexNotice = "";
		if (sexRadio) {
			sexRadio.checked = true;
		} else {
			var fallbackMale = document.querySelector('input[name="sex"][value="male"]');
			if (fallbackMale) fallbackMale.checked = true;
			sexNotice =
				" 注意：原武将的性别是「" + picked.sex + "」，游戏不认这个值，先按男性填了。";
		}

		setFieldValue("f-hp", hpFieldText(picked.hp));

		/* 技能：清空后按解析结果重建 */
		var skillList = $("skill-list");
		if (skillList) skillList.innerHTML = "";
		var list = picked.skills && picked.skills.length ? picked.skills : [{ name: "", desc: "" }];
		list.forEach(function (s, i) {
			addSkill(s.name || "", s.desc || "", i === 0, s.lines || []);
		});

		renderCard();

		if (picked.avatar) loadAvatarFromPath(picked.avatar);

		announce(
			sexNotice
				? "已载入「" + picked.name + "」，可以改了。" + sexNotice
				: "已载入「" + picked.name + "」，可以改了。",
		);
	}

	function setFieldValue(id, value) {
		var el = $(id);
		if (!el) return;
		el.value = value == null ? "" : String(value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}

	function escapeText(s) {
		return String(s).replace(/[&<>]/g, function (m) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m];
		});
	}
	function escapeAttr(s) {
		return escapeText(s).replace(/"/g, "&quot;");
	}

	/* 从扩展目录读立绘原图，喂给裁剪器 */
	function loadAvatarFromPath(path) {
		fetch("/api/avatar?path=" + encodeURIComponent(path), { cache: "no-store" })
			.then(function (r) {
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.blob();
			})
			.then(function (blob) {
				var reader = new FileReader();
				reader.onload = function () { loadImageSource(String(reader.result)); };
				reader.readAsDataURL(blob);
			})
			.catch(function (err) {
				console.error("[立绘] 读取失败：", err);
				announce("立绘没读出来，可以手动选一张图片。");
			});
	}

	function bindExtensionTarget() {
		var form = $("hero-form");
		var extInput = $("f-ext");
		var extPick = $("ext-pick");
		var extDir = $("f-ext-dir");
		var addBtn = $("add-skill");

		if (addBtn) {
			addBtn.addEventListener("click", function () {
				addSkill("", "");
			});
		}

		if (!form) return;

		/* 两种模式的界面不一样：
		 * 新建 → 手打扩展名；加入已有 → 直接挑文件夹，不让人手动输入名字。 */
		/* 模式切换统一交给 applyExtMode。
		 * 这里原本还有第二套 applyMode 与监听器 —— 两个监听器同时改同一批控件，
		 * 谁后跑谁说了算，出问题极难定位，已合并掉。 */

		if (extPick && extDir) {
			extPick.addEventListener("click", function () {
				extDir.click();
			});

			extDir.addEventListener("change", function () {
				var files = extDir.files;
				if (!files || !files.length) return;
				/* 上传整包：扩展名以包内 extension.js 的 name 为准（不再靠 zip 文件名猜），
				 * 同时让服务端把包留在工作区 —— AI 才有地方把新武将追加进去 */
				handleZipPick(files[0], "existing");
				extDir.value = "";
			});
		}

	}

	/* 自定义势力：空白框里直接打字，非空时接管卡面的势力字。
	 * 与六个预设势力互斥 —— 打字即取消预设选中，选预设即让自定义让位。 */
	/* 自定义选项：一个空白框里直接打字，非空时接管预设。
	 * 势力与性别共用这套逻辑 —— 势力额外要更新卡面，性别只影响提交数据。
	 * apply(value, preset) 里 value 为 null 表示「回到预设」。 */
	function bindCustomChoice(inputId, radioName, apply) {
		var input = $(inputId);
		if (!input) return;

		var box = input.closest(".choice--custom");
		var radios = document.querySelectorAll('input[name="' + radioName + '"]');
		var checkedSelector = 'input[name="' + radioName + '"]:checked';

		function presetValue() {
			var checked = document.querySelector(checkedSelector);
			return checked ? checked.value : null;
		}

		function applyCustom() {
			var value = input.value.trim();
			if (box) box.classList.toggle("is-active", !!value);

			if (value) {
				Array.prototype.forEach.call(radios, function (radio) {
					radio.checked = false;
				});
				apply(value);
			} else {
				apply(null, presetValue());
			}
		}

		input.addEventListener("input", applyCustom);

		/* 进入自定义模式。focus 与 click 都要监听 —— 框本身已经有焦点时
		 * 再点它不会触发 focus，而「选完预设再点回来」正好落在那个盲区。 */
		function enterCustom() {
			Array.prototype.forEach.call(radios, function (radio) {
				radio.checked = false;
			});
			if (box) box.classList.add("is-active");

			var value = input.value.trim();
			if (value) apply(value);
		}

		input.addEventListener("focus", enterCustom);
		input.addEventListener("click", enterCustom);

		/* 空着手离开则退回预设，不留一个空值 */
		input.addEventListener("blur", function () {
			if (input.value.trim()) return;
			if (box) box.classList.remove("is-active");
			apply(null, presetValue());
		});

		Array.prototype.forEach.call(radios, function (radio) {
			radio.addEventListener("change", function () {
				if (radio.checked && box) box.classList.remove("is-active");
			});
		});
	}

	/* 势力：自定义值要接管卡面。
	 * （性别没有自定义框了 —— 官方只有 male / female / double / none 四个值） */
	function bindCustomChoices() {
		bindCustomChoice("f-group-custom", "group", function (value, preset) {
			if (value) {
				setText("card-group", value);
				card.setAttribute("data-group", "custom");
			} else {
				renderGroup(preset || "wei");
			}
		});
	}

	/* ── 卡面识别 ────────────────────────────────────────────────────────
	 * 用户手上有做好的卡面图（第三方网站导出的、或自己画的），想让表单自己填好。
	 * 链路是「页面 → 落盘 → 对话里的 AI → 回填」，全程不引长连接：
	 *   1. 选卡面图（+ 可选立绘原图）
	 *   2. 前端把卡面裁成几块、各放大 3 倍 —— **放大是让 AI 认准字的关键**，
	 *      原图里竖排小字只有二十来像素高，放大后才看得清
	 *   3. POST /api/card-source 落盘
	 *   4. 用户回对话说一声，AI 读那些图识别，写 card-import.json
	 *   5. 这里轮询 /api/card-import，拿到就把结果填进表单
	 *
	 * 下面这组裁块坐标是拿真实卡面量出来的：这批卡面版式一致 ——
	 * 势力字在左上、勾玉在顶部一排、称号与名字竖排在左侧、技能在下部。
	 * 坐标是归一化的，所以原图多大都适用。 */
	var CI_BOXES = {
		group: [0.0, 0.0, 0.2, 0.15],
		pips: [0.14, 0.0, 0.62, 0.1],
		name: [0.0, 0.05, 0.26, 0.94],
		skill: [0.02, 0.5, 0.99, 0.98],
	};
	var CI_POLL_MS = 3000;
	var ciFiles = { card: null, art: null };
	var ciTimer = null;
	var ciRound = 0;        /* 识别轮次的计数器 */
	var ciActiveRound = 0;  /* 当前有效的那一轮；0 表示没有在等的轮次 */

	function ciStatus(text) {
		var el = $("ci-status");
		if (el) el.textContent = text;
	}

	function ciReadAsDataUrl(file) {
		return new Promise(function (resolve, reject) {
			var fr = new FileReader();
			fr.onload = function () {
				resolve(String(fr.result));
			};
			fr.onerror = function () {
				reject(new Error("读不了这个文件"));
			};
			fr.readAsDataURL(file);
		});
	}

	function ciLoadImage(src) {
		return new Promise(function (resolve, reject) {
			var img = new Image();
			img.onload = function () {
				resolve(img);
			};
			img.onerror = function () {
				reject(new Error("这张图打不开，换一张试试"));
			};
			img.src = src;
		});
	}

	/* 缩到长边不超过 maxSide：原图直接发会把 payload 撑得很大 */
	function ciCanvasOf(img, maxSide) {
		var w = img.naturalWidth,
			h = img.naturalHeight;
		var scale = Math.min(1, maxSide / Math.max(w, h));
		var cv = document.createElement("canvas");
		cv.width = Math.max(1, Math.round(w * scale));
		cv.height = Math.max(1, Math.round(h * scale));
		var ctx = cv.getContext("2d");
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(img, 0, 0, cv.width, cv.height);
		return cv;
	}

	/* 按归一化坐标裁一块并放大 */
	function ciCropPart(img, box, scale) {
		var w = img.naturalWidth,
			h = img.naturalHeight;
		var sx = Math.round(box[0] * w),
			sy = Math.round(box[1] * h);
		var sw = Math.max(1, Math.round((box[2] - box[0]) * w));
		var sh = Math.max(1, Math.round((box[3] - box[1]) * h));
		var cv = document.createElement("canvas");
		cv.width = Math.round(sw * scale);
		cv.height = Math.round(sh * scale);
		var ctx = cv.getContext("2d");
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
		return cv.toDataURL("image/jpeg", 0.92);
	}

	/* 识别按钮的可用性，两个条件都满足才亮：
	 *   ① 选了卡面图；
	 *   ② 若是「加入已有」，还得先选好扩展包 —— 没包的话识别结果不知道往哪儿加。 */
	function ciSyncStart() {
		var btn = $("ci-start");
		if (!btn) return;
		var modeEl = document.querySelector('input[name="extMode"]:checked');
		var mode = modeEl ? modeEl.value : "new";
		var extEl = $("f-ext");
		/* 识别卡面**只取决于有没有图**，跟模式无关 —— 它只是填表（认名字/势力/体力/技能），
		 * 加到哪个扩展是「提交」时才要管的事。所以「加入已有 / 修改已有」没选扩展包时，
		 * 识别按钮照样可点；只有到「提交给 AI」那一步才要求扩展就位。 */
		var disabled = !(ciFiles.card || ciFiles.art);
		btn.disabled = disabled;
		if (disabled) {
			ciStatus("先选一张图（卡面或立绘；只传立绘也行，AI 会把它存进扩展）。");
		}
	}

	/* 选中一张图：写名字、给个缩略图、更新按钮可用状态 */
	function ciPick(key, file) {
		ciFiles[key] = file || null;
		var nameEl = $("ci-name-" + key);
		var slot = $("ci-slot-" + key);
		if (nameEl) nameEl.textContent = file ? file.name : "选择图片";
		if (slot) slot.classList.toggle("is-filled", !!file);

		var thumb = $("ci-thumb-" + key);
		if (thumb) thumb.remove();
		if (file) {
			var img = document.createElement("img");
			img.className = "import-slot__thumb";
			img.id = "ci-thumb-" + key;
			img.alt = "";
			ciReadAsDataUrl(file).then(function (url) {
				img.src = url;
			});
			if (slot) slot.appendChild(img);
		}

		ciSyncStart();
	}

	function ciBindSlot(key) {
		var input = $("ci-" + key);
		if (!input) return;
		var accept = function (f) {
			if (!f) return;
			if (!/^image\//.test(f.type)) {
				ciStatus("这个不是图片文件，换一张。");
				input.value = "";
				return;
			}
			ciPick(key, f);
			/* 立绘图直接喂给右边的裁剪器 —— 它跟识别无关，
			 * 用户选完立刻就能在裁剪器里调整 */
			if (key === "art") {
				ciReadAsDataUrl(f).then(function (url) {
					loadImageSource(url);
				});
			}
			if (key === "card") ciStatus("");
		};
		input.addEventListener("change", function () {
			accept(input.files && input.files[0]);
		});

		/* 拖拽：把图片文件直接拖到槽上就等于选了它，不用点开文件选择框 */
		var slot = $("ci-slot-" + key);
		if (!slot) return;
		["dragenter", "dragover"].forEach(function (ev) {
			slot.addEventListener(ev, function (e) {
				e.preventDefault();
				slot.classList.add("is-dragover");
			});
		});
		slot.addEventListener("dragleave", function () {
			slot.classList.remove("is-dragover");
		});
		slot.addEventListener("drop", function (e) {
			e.preventDefault();
			slot.classList.remove("is-dragover");
			var dt = e.dataTransfer;
			accept(dt && dt.files && dt.files[0]);
		});
	}

	/* 停轮询，并把当前这一轮**作废**。
	 * 只清定时器是不够的：请求可能已经发出、结果稍后才回来，那笔迟到的结果
	 * 仍会走完 ciApply 把表单填上（实测：用户点「清空」之后，几秒前发出的
	 * 结果又把表单填回来了）。所以用一个轮次号标记"这一轮还算不算数"。 */
	function ciStopPoll() {
		ciActiveRound = 0;
		if (ciTimer) {
			clearInterval(ciTimer);
			ciTimer = null;
		}
	}

	/* 开一轮新的识别，返回本轮编号。 */
	function ciBeginRound() {
		ciStopPoll();
		return (ciActiveRound = ++ciRound);
	}

	/* 用指定轮次开始轮询结果。轮次号由 ciBeginRound 给出 —— 上传是异步的，
	 * 用户可能在上传途中就点了「清空」，那时轮次已作废，这里不会再启动。 */
	function ciPollRound(mine) {
		if (ciTimer) {
			clearInterval(ciTimer);
			ciTimer = null;
		}
		ciActiveRound = mine;
		var tick = function () {
			fetch("/api/card-import", { cache: "no-store" })
				.then(function (r) {
					return r.ok ? r.json() : null;
				})
				.then(function (data) {
					if (!data) return;
					/* 这一轮已被作废（用户清空了表单 / 重新发起识别）→ 丢弃结果 */
					if (mine !== ciActiveRound) return;
					ciStopPoll();
					ciApply(data);
				})
				.catch(function () {
					/* 服务没起来之类，下一轮再试 */
				});
		};
		ciTimer = setInterval(tick, CI_POLL_MS);
		tick();
	}

	/* 把识别结果填进表单。字段对不上就跳过，绝不清空用户已经填好的东西。 */
	/* 把识别结果填进表单 —— **只填空白项**。
	 * 已经填了内容的一律不动（「修改已有」载入的原值、用户手填的都在此列），
	 * 最后统计"哪些项因为已填而没覆盖"，在状态行说清楚。
	 * 判据要区分"默认值"与"用户填的"：势力出生就选中「魏」、体力默认 4/4/0，
	 * 这两个不能算已填，否则识别结果永远填不进去。 */
	function ciApply(data) {
		var kept = [];

		/* 立绘：AI 把它存进扩展目录后会在结果里带 artSaved —— 这里把「已经就位」交代清楚。
		 * （立绘本身在选图时就已经进右边裁剪器了，这里只是汇报保存结果。） */
		if (data.artSaved) {
			setTimeout(function () {
				announce("立绘已经存进扩展：" + data.artSaved);
			}, 0);
		}

		var put = function (key, value, label) {
			if (!value) return;
			var el = $(key);
			if (!el) return;
			var cur = el.value.trim();
			if (cur) {
				if (cur !== String(value).trim()) kept.push(label);
				return;
			}
			setFieldValue(key, value);
		};

		put("f-name", data.name, "武将名");
		put("f-title", data.title, "称号");

		/* 势力：自定义框有值、或选中的不是默认的「魏」，就算已填
		 * （能对上六个预设就点预设，否则进自定义框 —— 与「修改已有」回填同一套路） */
		if (data.group) {
			var custom = $("f-group-custom");
			var checked = document.querySelector('input[name="group"]:checked');
			var groupIsDefault = !(custom && custom.value.trim()) && (!checked || checked.value === "wei");
			if (groupIsDefault) {
				var radio = document.querySelector('input[name="group"][value="' + data.group + '"]');
				if (radio) {
					radio.checked = true;
					radio.dispatchEvent(new Event("change", { bubbles: true }));
					if (custom) custom.value = "";
				} else if (custom) {
					custom.value = data.group;
					custom.dispatchEvent(new Event("input", { bubbles: true }));
				}
			} else {
				var nowGroup = (custom && custom.value.trim()) || (checked ? checked.value : "");
				if (nowGroup !== data.group) kept.push("势力");
			}
		}

		/* 体力：空着、或还是默认的 4/4/0，都算未填 */
		if (data.hp) {
			var hpEl = $("f-hp");
			var hpNow = hpEl ? hpEl.value.trim() : "";
			var hpWant = hpFieldText(data.hp);
			if (!hpNow || hpNow === "4/4/0") {
				setFieldValue("f-hp", hpWant);
			} else if (hpNow !== hpWant) {
				kept.push("体力");
			}
		}

		/* 技能：整块一个字都没写时才重建；写了任何内容就整块保留 */
		if (data.skills && data.skills.length) {
			var list = getSkills();
			var untouched = list.every(function (s) {
				return (
					!(s.name || "").trim() &&
					!(s.desc || "").trim() &&
					!(s.lines || []).length &&
					!(s.audioFiles || []).length
				);
			});
			if (untouched) {
				var skillList = $("skill-list");
				if (skillList) skillList.innerHTML = "";
				data.skills.forEach(function (s, i) {
					addSkill(s.name || "", s.desc || "", i === 0, s.lines || []);
				});
			} else {
				kept.push("技能");
			}
		}

		renderCard();

		var base = "识别完成，核对一下再提交。";
		var tail = kept.length ? "这几项你已经填过，没有覆盖：" + kept.join("、") + "。" : "";
		ciStatus(base + tail);
		announce((data.note ? data.note + " " : "") + base + tail);

		var btn = $("ci-start");
		if (btn) btn.disabled = false;
	}

	function ciStart() {
		var cardFile = ciFiles.card;
		var artFile = ciFiles.art;
		if (!cardFile && !artFile) {
			ciStatus("先选一张图（卡面或立绘）。");
			return;
		}
		var btn = $("ci-start");
		if (btn) btn.disabled = true;
		ciStatus("正在准备图片……");

		/* 开一轮，并把编号带进整条异步链：读图、裁块、上传全是异步的，
		 * 用户可能在途中就点了「清空」—— 那时这一轮要作废，否则上传完成后
		 * 又会重新激活轮询，迟到的结果照样把表单填回来。 */
		var myRound = ciBeginRound();

		/* 卡面或立绘**至少一张**就能识别：
		 *   只有卡面 → 裁块给 AI 认字，照旧
		 *   只有立绘 → 不裁块，AI 只负责把立绘存进扩展（它没有文字可认）
		 *   两张都有 → 全做 */
		var cardJob = cardFile
			? ciReadAsDataUrl(cardFile)
				.then(ciLoadImage)
				.then(function (img) {
					var shrunk = ciCanvasOf(img, 1400);
					var dataUrl = shrunk.toDataURL("image/jpeg", 0.92);
					return ciLoadImage(dataUrl).then(function (loaded) {
						var parts = {};
						Object.keys(CI_BOXES).forEach(function (k) {
							parts[k] = ciCropPart(loaded, CI_BOXES[k], 3);
						});
						return {
							card: dataUrl,
							parts: parts,
							cardSize: { w: img.naturalWidth, h: img.naturalHeight },
						};
					});
				})
			: Promise.resolve({ card: null, parts: {}, cardSize: null });

		var artJob = artFile
			? ciReadAsDataUrl(artFile)
				.then(ciLoadImage)
				.then(function (a) {
					return ciCanvasOf(a, 1400).toDataURL("image/jpeg", 0.92);
				})
			: Promise.resolve(null);

		Promise.all([cardJob, artJob])
			.then(function (r) {
				var bundle = r[0];
				var artDataUrl = r[1];
				ciStatus("正在上传……");
				return fetch("/api/card-source", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						card: bundle.card,
						art: artDataUrl,
						parts: bundle.parts,
						cardSize: bundle.cardSize,
					}),
				});
			})
			.then(function (r) {
				return r.json().then(function (body) {
					return { ok: r.ok, body: body };
				});
			})
			.then(function (res) {
				if (!res.ok) throw new Error((res.body && res.body.error) || "上传失败");
				/* 这一轮已被作废（用户清空了表单 / 又发起了一次识别）→ 不提示、不轮询 */
				if (myRound !== ciActiveRound) return;
				ciStatus("已经交给 AI 了 —— 回到对话窗口说一声（说什么都行），识别结果会自动填进来。");
				ciPollRound(myRound);
			})
			.catch(function (err) {
				ciStatus("没成功：" + err.message);
				if (btn) btn.disabled = false;
			});
	}

	function bindCardImport() {
		ciBindSlot("card");
		ciBindSlot("art");
		var start = $("ci-start");
		if (start) start.addEventListener("click", ciStart);

		/* 清空表单时把等待中的识别一并作废 —— 否则几秒后迟到的结果
		 * 会把用户刚清空的表单又填回去（实测过）。
		 * （面板的收起在 form 的 reset 处理里做，见那里对 setPanelOpen 的调用。） */
		var resetBtn = document.querySelector('button[type="reset"][form="hero-form"]');
		if (resetBtn) resetBtn.addEventListener("click", ciStopPoll);

		/* 「加入已有」没选扩展包时，识别按钮保持不可点；选了包（扩展名被自动填上）就恢复。
		 * 触点在两处：切换扩展模式、扩展名输入框的值变化。 */
		Array.prototype.forEach.call(
			document.querySelectorAll('input[name="extMode"]'),
			function (r) {
				r.addEventListener("change", ciSyncStart);
			},
		);
		var extInput = $("f-ext");
		if (extInput) extInput.addEventListener("input", ciSyncStart);
		ciSyncStart();

		/* 默认收起 —— 入口是「武将设定」标题行右侧那个小按钮。
		 * 工作台是「四周填、中间看」，这块不该默认杵在表单最上面。 */
		var toggle = $("ci-toggle");
		if (toggle) {
			toggle.addEventListener("click", function () {
				var panel = $("card-import");
				if (panel) setPanelOpen(panel.hidden);
			});
		}

		/* 页面一加载就主动读一次已有结果。
		 * 轮询只在点「开始识别」之后才启动，用户中途刷新页面就永久丢了 ——
		 * AI 之后写的 card-import.json 接口里有数据，页面却再也不请求
		 * （2026-10-17 实测：用户 01:16 上传、AI 01:25 写结果，中间他刷过页面，
		 *  一直看不到回填，还以为是识别失败）。
		 * ciApply 只填空白项，不会覆盖用户已经填好的东西。 */
		fetch("/api/card-import", { cache: "no-store" })
			.then(function (r) {
				return r.ok ? r.json() : null;
			})
			.then(function (data) {
				if (!data) return;
				ciApply(data);
				announce("已载入上一次的识别结果（换张卡就重新上传，或点「清空」）。");
			})
			.catch(function () {
				/* 服务没起来之类 —— 用户没点识别，不该被打扰 */
			});
	}

	/* 展开 / 收起「识别卡面」面板。清空表单时也要收（见上面 resetBtn 的处理），
	 * 所以抽成函数，两处共用 —— 状态一律以面板自己的 hidden 为准。 */
	function setPanelOpen(open) {
		var toggle = $("ci-toggle");
		var panel = $("card-import");
		if (!toggle || !panel) return;
		panel.hidden = !open;
		toggle.setAttribute("aria-expanded", open ? "true" : "false");
		toggle.textContent = open ? "收起" : "识别卡面";
		/* 展开后把面板带到眼前（面板在表单上方，页面长了会看不见） */
		if (open) {
			panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();