--  dmg-layout.applescript
--  Type by Voice
--
--  Sets the drag-to-install window layout on a mounted TypeByVoice volume, so
--  Finder records it in the volume's .DS_Store: icon-view window at a fixed
--  size, no toolbar or status bar, 128pt icons, the app on the left and the
--  Applications alias on the right, arrow backdrop behind them.
--
--  Finder is the only writer of these settings. The .DS_Store they land in is a
--  "Bud1" container, not a plist (`plutil` refuses it) with no documented byte
--  layout for icon geometry, so authoring it by hand is not worth the risk.
--
--  Called by macos/Scripts/package-dmg.sh. It needs permission to control
--  Finder (System Settings > Privacy & Security > Automation) from a normal
--  Terminal window — a sandboxed or agent-run shell is refused with
--  "Finder got an error: A privilege violation occurred. (-10004)", which
--  package-dmg.sh turns into an explicit message.
--
--  Usage:
--      osascript macos/Scripts/dmg-layout.applescript <volumeName>

on run argv
	if (count of argv) < 1 then error "usage: osascript dmg-layout.applescript <volumeName>" number 2
	set volName to item 1 of argv

	-- Geometry. An item's `position` is the top-left corner of its frame (icon
	-- plus label), so its visual centre is position + iconSize / 2. These x
	-- values put both item centres on y = 212 — the arrow's centre line in
	-- macos/Installer/dmg-background.png (see make-dmg-background.swift).
	set windowBounds to {400, 100, 940, 500} -- 540x400, title bar included
	set iconSize to 128
	set textSize to 14
	set appPosition to {116, 148}
	set folderPosition to {324, 148}

	tell application "Finder"
		-- Addressing Finder at all is the permission probe: without the grant
		-- this raises -10004 and the caller reports the fix instead of shipping
		-- an unstyled DMG.
		tell disk (volName as text)
			open
			set current view of container window to icon view
			set toolbar visible of container window to false
			set statusbar visible of container window to false
			-- Finder window bounds include the title bar, so the backdrop's
			-- bottom ~28pt is clipped. Invisible here: the canvas is transparent
			-- with a centred arrow.
			set bounds of container window to windowBounds

			set viewOptions to the icon view options of container window
			-- Arrange first: auto-arrange rewrites the positions set below it.
			set arrangement of viewOptions to not arranged
			set icon size of viewOptions to iconSize
			set text size of viewOptions to textSize
			-- Volume-relative on purpose: the alias Finder stores has to survive
			-- remounting at /Volumes/TypeByVoice for whoever downloads the DMG,
			-- so it must not point at a build-time path.
			set background picture of viewOptions to file ".background:dmg-background.tiff"

			set position of item "TypeByVoice.app" of container window to appPosition
			set position of item "Applications" of container window to folderPosition

			update without registering applications
			-- Finder writes .DS_Store lazily; the caller detaches after this
			-- returns, so give it a moment to land on disk.
			delay 2
			close
		end tell
	end tell

	return "ok"
end run
