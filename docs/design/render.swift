import AppKit

// Static, native-drawn design artifacts. Run from the repository root.
let W: CGFloat = 1440, H: CGFloat = 1040
let ink = "263334", muted = "657273", faint = "758080"
let accent = "23695F", selected = "E3EEEA", border = "E1E7E4", panel = "F2F5F3"
func color(_ hex: String) -> NSColor {
    let n = UInt32(hex, radix: 16)!
    return NSColor(srgbRed: CGFloat((n >> 16) & 255)/255, green: CGFloat((n >> 8) & 255)/255, blue: CGFloat(n & 255)/255, alpha: 1)
}
func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ fill: String, _ radius: CGFloat = 0, _ stroke: String? = nil) {
    let path = NSBezierPath(roundedRect: NSRect(x: x,y: y,width: w,height: h), xRadius: radius,yRadius: radius)
    color(fill).setFill(); path.fill()
    if let stroke { color(stroke).setStroke(); path.lineWidth = 1; path.stroke() }
}
func line(_ x: CGFloat,_ y: CGFloat,_ x2: CGFloat,_ y2: CGFloat) {
    let p = NSBezierPath(); p.move(to: NSPoint(x:x,y:y)); p.line(to:NSPoint(x:x2,y:y2)); color(border).setStroke(); p.lineWidth = 1; p.stroke()
}
func text(_ s: String,_ x: CGFloat,_ y: CGFloat,_ size: CGFloat = 14,_ hex: String = ink,_ weight: NSFont.Weight = .regular,_ width: CGFloat = 1000) {
    let p = NSMutableParagraphStyle(); p.lineSpacing = 5
    (s as NSString).draw(in: NSRect(x:x,y:y,width:width,height:160), withAttributes: [.font:NSFont.systemFont(ofSize:size,weight:weight), .foregroundColor:color(hex), .paragraphStyle:p])
}
func icon(_ name: String,_ x: CGFloat,_ y: CGFloat,_ size: CGFloat = 18,_ hex: String = muted) {
    guard let img = NSImage(systemSymbolName:name,accessibilityDescription:nil)?.withSymbolConfiguration(.init(pointSize:size,weight:.regular)) else { return }
    let tinted = NSImage(size: img.size)
    tinted.lockFocus(); color(hex).set(); NSRect(origin:.zero,size:img.size).fill(); img.draw(at:.zero,from:.zero,operation:.destinationIn,fraction:1); tinted.unlockFocus()
    tinted.draw(in:NSRect(x:x,y:y,width:size,height:size),from:.zero,operation:.sourceOver,fraction:1,respectFlipped:true,hints:nil)
}
func button(_ s: String,_ x: CGFloat,_ y: CGFloat,_ w: CGFloat,_ primary: Bool = false,_ sym: String? = nil) {
    box(x,y,w,34,primary ? accent : "FFFFFF",8,primary ? nil : border)
    if let sym { icon(sym,x+12,y+9,16,primary ? "FFFFFF" : muted) }
    text(s,x+(sym == nil ? 14 : 36),y+8,13,primary ? "FFFFFF" : ink,.medium,w-20)
}
func field(_ label: String,_ value: String,_ x: CGFloat,_ y: CGFloat,_ width: CGFloat,_ h: CGFloat = 40,_ dropdown: Bool = false) {
    text(label,x,y,12,muted,.medium)
    box(x,y+24,width,h,"FFFFFF",8,border); text(value,x+13,y+35,14,ink,.regular,width-36)
    if dropdown { icon("chevron.down",x+width-27,y+38,12) }
}
func base(_ number: String,_ title: String,_ desc: String,_ active: Int) {
    box(0,0,W,H,"E9EEEB")
    text("Tandem",64,28,22,ink,.semibold)
    text("原生 macOS · 界面视觉提案",177,35,13,muted)
    text(number+"  /  "+title,1000,34,14,muted,.medium,360)
    let shadow = NSShadow(); shadow.shadowColor = color("BECBC3").withAlphaComponent(0.35); shadow.shadowBlurRadius = 25; shadow.shadowOffset = NSSize(width:0,height:-8)
    NSGraphicsContext.saveGraphicsState(); shadow.set(); box(64,96,1312,820,"FFFFFF",16); NSGraphicsContext.restoreGraphicsState()
    box(64,96,238,820,panel,16)
    box(284,96,18,820,panel)
    line(302,96,302,916)
    for (i,c) in ["EC7368","E8BD58","77BD8A"].enumerated() { box(84+CGFloat(i)*20,118,11,11,c,6) }
    icon("sidebar.left",264,116,18)
    box(84,162,30,30,accent,9); icon("circle.lefthalf.filled",91,169,16,"FFFFFF")
    text("Tandem",124,164,20,ink,.semibold)
    text("让想法，持续向前。",85,207,12,muted)
    let nav = [("对话","bubble.left.and.bubble.right"),("项目","folder"),("模型设置","slider.horizontal.3")]
    for (i,item) in nav.enumerated() {
        let y = 252+CGFloat(i)*44
        if active == i { box(78,y-4,210,36,selected,8) }
        icon(item.1,92,y+5,18,active == i ? accent : muted)
        text(item.0,122,y+3,14,active == i ? accent : ink,active == i ? .semibold : .regular)
    }
    text("最近话题",88,413,11,muted,.medium)
    let topics = ["Tandem 界面优化","周末徒步计划","梳理产品方向"]
    for (i,t) in topics.enumerated() {
        let y = 447+CGFloat(i)*40
        if active == 0 && i == 0 { box(78,y-5,210,34,"E8ECE9",7) }
        icon("text.bubble",92,y+3,15); text(t,119,y+1,13,ink,.regular,162)
    }
    line(84,842,282,842)
    icon("waveform.path",90,866,17,accent); text("运行状态",118,864,13,ink)
    text("本地运行 · 已连接",89,890,11,muted)
    text(title,334,116,17,ink,.semibold)
    line(302,156,1376,156)
    text(desc,66,947,16,ink,.medium)
    text("视觉提案 · 示例内容 · 非运行截图",66,981,12,muted)
    text("2026.11   /   Tandem",1174,981,12,muted)
}
func composer(_ x: CGFloat,_ y: CGFloat,_ width: CGFloat) {
    box(x,y,width,130,"FFFFFF",14,"CAD7D0")
    text("继续这个想法，或开始一个新问题…",x+20,y+20,15,muted)
    box(x+14,y+81,186,32,panel,7)
    icon("circle.hexagongrid",x+25,y+90,15)
    text("默认模型 · model-a",x+48,y+90,12,ink)
    icon("chevron.down",x+177,y+92,11)
    text("临时插话",x+216,y+90,12,muted); icon("chevron.down",x+275,y+92,11)
    box(x+width-50,y+80,34,34,accent,10); icon("arrow.up",x+width-41,y+89,16,"FFFFFF")
    text("全局连续历史 · 仅向模型发送当前话题相关消息",x,y+145,11,muted)
    text("⌘ ↵ 发送",x+width-76,y+145,11,muted)
}
func chat() {
    base("01","对话","阅读优先：弱化操作噪声，让对话、项目归属与输入自然分层。",0)
    text("当前话题：Tandem 界面优化",334,175,13,muted)
    button("全部项目历史",1081,167,145,false,"line.3.horizontal.decrease")
    button("新话题",1238,167,106,false,"square.and.pencil")
    let x: CGFloat = 452
    text("今天",814,228,11,muted)
    text("Tandem 界面优化",x,267,12,accent,.medium)
    box(x,295,724,88,"F1F4F2",12)
    text("你",x+20,309,12,muted,.medium)
    text("希望 Tandem 更像一个安静、清晰的原生工作台。",x+20,334,16,ink)
    box(x,419,28,28,selected,8); icon("circle.lefthalf.filled",x+7,426,14,accent)
    text("Tandem",x+40,422,14,ink,.semibold)
    text("model-a · primary",x+118,425,11,muted)
    icon("ellipsis",x+704,427,18)
    text("我们可以先把注意力还给内容。",x,470,23,ink,.semibold)
    text("保留熟悉的侧栏，把常用设置放在输入区附近。\n让每一段对话都更容易阅读，也更容易继续。",x,516,15,ink,.regular,724)
    line(x,591,x+724,591)
    text("清晰的层级",x,612,14,ink,.semibold)
    text("正文保持舒展；模型、归属和执行信息退到第二层。",x+130,612,14,muted)
    icon("doc.text.magnifyingglass",x,660,15)
    text("执行上下文",x+23,658,12,muted)
    text("项目归属：Tandem 界面优化",x+143,658,12,accent)
    icon("chevron.down",x+327,662,10,accent)
    icon("ellipsis",x+704,660,18)
    box(x,704,170,29,panel,7); icon("scope",x+10,712,14,accent)
    text("上下文：自动",x+33,711,12,ink); icon("chevron.down",x+147,714,10)
    box(x+182,704,231,29,panel,7); icon("folder",x+192,712,14)
    text("项目：Tandem 界面优化",x+216,711,12,ink); icon("chevron.down",x+390,714,10)
    composer(x,744,724)
}
func projects() {
    base("02","项目","管理优先：列表与详情分离，归档和永久删除明确区分。",1)
    button("新建项目",1220,107,124,true,"plus")
    text("长期目标，持续积累",334,185,24,ink,.semibold)
    text("项目用于整理相关对话；普通问题也可以不关联项目。",334,226,14,muted)
    let x: CGFloat = 334, y: CGFloat = 283
    text("进行中",x,y,13,ink,.semibold); text("2 个项目",x+197,y+1,12,muted)
    box(x,y+38,280,89,selected,10)
    icon("folder",x+16,y+55,21,accent); text("Tandem 界面优化",x+50,y+53,15,accent,.semibold)
    text("打造清晰的原生工作台",x+50,y+82,12,muted)
    icon("chevron.right",x+253,y+72,12,accent)
    icon("folder",x+16,y+158,21); text("周末徒步",x+50,y+157,15,ink,.medium)
    text("路线、装备与行程准备",x+50,y+187,12,muted)
    line(x,y+235,x+280,y+235)
    icon("archivebox",x+8,y+257,16); text("显示归档项目",x+34,y+255,13,muted)
    box(x+240,y+255,30,18,"D7DEDA",9); box(x+242,y+257,14,14,"FFFFFF",7)
    line(648,283,648,862)
    let d: CGFloat = 686
    icon("folder",d,284,22,accent); text("项目详情",d+34,284,17,ink,.semibold)
    text("进行中",1254,288,12,accent)
    field("项目名称","Tandem 界面优化",d,345,620)
    field("目标或说明","优化对话、项目管理与模型设置的视觉层级。\n保持原生体验，让常用操作更容易找到。",d,443,620,132)
    button("保存修改",d,642,108,true)
    line(d,714,1306,714)
    text("项目管理",d,739,14,ink,.semibold)
    text("归档后保留全部历史，可以随时恢复。",d,770,13,muted)
    button("归档项目",1188,749,118,false,"archivebox")
    text("预览永久删除…",d,832,12,"9B4441",.medium)
    text("先查看影响范围，再确认删除。",d+124,832,12,muted)
}
func settings() {
    base("03","模型设置","配置优先：接入项分组、明确字段层级，保存动作始终可见。",2)
    button("重新加载",1133,107,100)
    button("保存配置",1245,107,99,true)
    let x: CGFloat = 358
    text("连接你的模型",x,191,24,ink,.semibold)
    text("管理模型接入与默认选择。",x,232,14,muted)
    box(x,281,970,90,panel,12)
    icon("circle.hexagongrid",x+20,303,22,accent)
    text("全局默认模型",x+56,299,14,ink,.semibold)
    text("手动选择优先；已有回答与排队请求保留原模型。",x+56,329,12,muted)
    button("model-a · primary",1086,307,218); icon("chevron.down",1280,318,11)
    text("模型接入",x,410,15,ink,.semibold)
    button("添加接入项",1187,399,141,false,"plus")
    box(x,455,216,74,selected,9)
    icon("network",x+16,472,19,accent); text("primary",x+49,469,14,accent,.semibold)
    text("OpenAI 兼容",x+49,497,12,muted)
    icon("network",x+16,556,19); text("secondary",x+49,553,14,ink,.medium)
    text("Anthropic 兼容",x+49,581,12,muted)
    line(598,455,598,789)
    let d: CGFloat = 630
    text("接入项 · primary",d,455,16,ink,.semibold)
    text("移除此接入项",1225,458,12,"9B4441")
    field("协议","OpenAI 兼容",d,501,331,40,true)
    field("API 类型","Chat Completions",981,501,347,40,true)
    field("API Base URL","https://api.example.com/v1",d,586,698)
    text("将在 Base URL 后追加 /chat/completions；需要 /v1 时请在地址中包含。",d,659,11,muted)
    field("API Key","••••••••••••••••••••••••",d,696,331)
    field("模型名（每行一个）","model-a\nmodel-b",981,696,347,66)
    box(x,833,970,57,panel,9)
    icon("internaldrive",x+16,851,18)
    text("本机保存",x+46,844,12,ink,.medium)
    text("API Key 明文保存在 ~/.tandem/config.json；不写入聊天数据库或日志。",x+46,865,11,muted)
}
let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("docs/design")
let pages: [(String, () -> Void)] = [("01-conversation",chat),("02-projects",projects),("03-model-settings",settings)]
for (name, draw) in pages {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:Int(W*2),pixelsHigh:Int(H*2),bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0), let context = NSGraphicsContext(bitmapImageRep:rep) else { fatalError("Cannot create canvas") }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
    let cg = context.cgContext; cg.scaleBy(x:2,y:2); cg.translateBy(x:0,y:H); cg.scaleBy(x:1,y:-1)
    NSGraphicsContext.current = NSGraphicsContext(cgContext:cg,flipped:true)
    draw(); NSGraphicsContext.restoreGraphicsState()
    let data = rep.representation(using:.png,properties:[:])!
    try data.write(to:output.appendingPathComponent(name+".png"))
    assert(rep.pixelsWide == 2880 && rep.pixelsHigh == 2080 && data.count > 10000)
    print("Rendered \(name): \(rep.pixelsWide) × \(rep.pixelsHigh)")
}
