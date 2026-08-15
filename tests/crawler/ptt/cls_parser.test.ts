import { test, expect } from "bun:test";
import { parseClsPage } from "../../../src/crawler/ptt/cls_parser.ts";

test("parseClsPage (categories + boards)", () => {
  const html = `<html><body>
	<div class="b-list-container">
		<div class="b-ent">
			<a class="board" href="/cls/802">
				<div class="board-name">H_Group</div>
				<div class="board-nuser"></div>
				<div class="board-class">一一</div>
				<div class="board-title">Σ戰略高手 遊戲, 數位, 程設</div>
			</a>
		</div>
		<div class="b-ent">
			<a class="board" href="/bbs/Gossiping/index.html">
				<div class="board-name">Gossiping</div>
				<div class="board-nuser"><span class="hl">4557</span></div>
				<div class="board-class">綜合</div>
				<div class="board-title">◎[八卦] 世界大象日</div>
			</a>
		</div>
		<div class="b-ent">
			<a class="board" href="/bbs/PC_Shopping/index.html">
				<div class="board-name">PC_Shopping</div>
				<div class="board-nuser">248</div>
				<div class="board-class">硬體</div>
				<div class="board-title">◎[電蝦] 50系列顯卡限組裝</div>
			</a>
		</div>
		<div class="b-ent">
			<a class="board" href="/bbs/Blog/index.html">
				<div class="board-name">Blog</div>
				<div class="board-nuser"></div>
				<div class="board-class">生活</div>
				<div class="board-title">◎部落格板</div>
			</a>
		</div>
	</div></body></html>`;

  const entries = parseClsPage(html);
  expect(entries.length).toBe(4);

  // First entry: sub-category
  const cat = entries[0]!;
  expect(cat.isBoard).toBe(false);
  expect(cat.name).toBe("H_Group");
  expect(cat.href).toBe("/cls/802");
  expect(cat.userCount).toBe(0);

  // Second entry: board with span-wrapped user count
  const b1 = entries[1]!;
  expect(b1.isBoard).toBe(true);
  expect(b1.name).toBe("Gossiping");
  expect(b1.href).toBe("/bbs/Gossiping/index.html");
  expect(b1.userCount).toBe(4557);
  expect(b1.title).toBe("◎[八卦] 世界大象日");

  // Third entry: board with plain text user count
  const b2 = entries[2]!;
  expect(b2.userCount).toBe(248);
  expect(b2.class).toBe("硬體");

  // Fourth entry: board with no user count
  expect(entries[3]!.userCount).toBe(0);
});
