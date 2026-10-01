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

	-- Geometry. Finder's item `position` is the item's CENTRE, not its frame's
	-- top-left corner: asking for {116, 148} puts the icon's centre there (seen
	-- on a real build), and y is measured from the top of the content view.
	--
	-- The backdrop canvas is contentWidth x contentHeight, and Finder draws a
	-- picture that is taller than the content view clipped from the top. So the
	-- frame has to leave exactly the canvas's height of *content*, or the arrow
	-- lands a title bar's height above the icons: measured on a real build, the
	-- frame was 400 with a 22pt title bar, the content came out ~378, and the
	-- arrow sat 22.2pt above the icons' centres.
	set contentWidth to 540
	set contentHeight to 400
	set titleBarHeight to 22
	set windowBounds to {400, 100, 400 + contentWidth, 100 + contentHeight + titleBarHeight}
	set windowCentreX to contentWidth / 2
	set iconSize to 128
	set textSize to 14
	-- The arrow in macos/Installer/dmg-background.png is centred at
	-- contentWidth / 2 and y = 212 (see make-dmg-background.swift).
	set iconCentreY to 212
	-- Per side: 64 (half an icon) + 36 (half the 72pt arrow) + 24 clearance.
	set iconOffsetX to 124
	set appPosition to {windowCentreX - iconOffsetX, iconCentreY}
	set folderPosition to {windowCentreX + iconOffsetX, iconCentreY}

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
