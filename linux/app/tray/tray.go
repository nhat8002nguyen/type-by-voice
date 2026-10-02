// Package tray shows a StatusNotifierItem tray icon over the session D-Bus.
//
// It is deliberately pure Go: the classic libayatana-appindicator3 binding is a
// GTK 3 library, and loading GTK 3 symbols into our GTK 4 process makes GTK
// abort with "GTK 2/3 symbols detected ... not supported". GTK 4 has no
// GtkStatusIcon, so the tray speaks the status-notifier protocol itself.
package tray

import (
	"fmt"
	"log"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
	"github.com/godbus/dbus/v5/prop"
)

// Actions are the tray menu callbacks.
type Actions struct {
	OnSettings  func()
	OnDashboard func()
	OnRecord    func()
	OnQuit      func()
}

const (
	serviceName      = "org.kde.StatusNotifierItem.typebyvoice"
	sniInterface     = "org.kde.StatusNotifierItem"
	sniPath          = dbus.ObjectPath("/StatusNotifierItem")
	menuInterface    = "com.canonical.dbusmenu"
	menuPath         = dbus.ObjectPath("/MenuBar")
	watcherBus       = "org.kde.StatusNotifierWatcher"
	watcherPath      = dbus.ObjectPath("/StatusNotifierWatcher")
	watcherInterface = "org.kde.StatusNotifierWatcher"
)

// Menu item ids.
const (
	idRoot      = 0
	idRecord    = 1
	idSettings  = 2
	idDashboard = 3
	idQuit      = 4
)

// Tray is the StatusNotifierItem tray icon.
type Tray struct {
	conn *dbus.Conn
}

// New connects to the session bus and registers a StatusNotifierItem. It
// returns an error when there is no session bus or no watcher; the caller logs
// and continues, because the tray is not required for dictation.
func New(actions Actions) (*Tray, error) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("tray: session bus: %w", err)
	}

	sni := &sniHandler{actions: actions}
	if err := conn.Export(sni, sniPath, sniInterface); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tray: export item: %w", err)
	}
	if err := conn.Export(&menuHandler{actions: actions}, menuPath, menuInterface); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tray: export menu: %w", err)
	}

	spec := map[string]map[string]*prop.Prop{
		sniInterface: {
			"Category":   {Value: "ApplicationStatus", Emit: prop.EmitFalse},
			"Id":         {Value: "typebyvoice", Emit: prop.EmitFalse},
			"Title":      {Value: "Type by Voice", Emit: prop.EmitFalse},
			"Status":     {Value: "Active", Emit: prop.EmitFalse},
			"IconName":   {Value: "audio-input-microphone", Emit: prop.EmitFalse},
			"Menu":       {Value: menuPath, Emit: prop.EmitFalse},
			"ItemIsMenu": {Value: true, Emit: prop.EmitFalse},
			"WindowId":   {Value: int32(0), Emit: prop.EmitFalse},
		},
	}
	if _, err := prop.Export(conn, sniPath, spec); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tray: export properties: %w", err)
	}
	if err := conn.Export(introspect.NewIntrospectable(&introspect.Node{
		Name: string(sniPath),
		Interfaces: []introspect.Interface{
			introspect.IntrospectData,
			prop.IntrospectData,
		},
	}), sniPath, "org.freedesktop.DBus.Introspectable"); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("tray: export introspection: %w", err)
	}

	// Owning a well-known name and registering it with the watcher is best
	// effort: some desktops have no watcher running.
	if reply, err := conn.RequestName(serviceName, dbus.NameFlagDoNotQueue); err == nil &&
		reply == dbus.RequestNameReplyPrimaryOwner {
		if err := conn.Object(watcherBus, watcherPath).
			Call(watcherInterface+".RegisterStatusNotifierItem", 0, serviceName).Err; err != nil {
			log.Printf("tray: watcher registration: %v", err)
		}
	}
	return &Tray{conn: conn}, nil
}

// Close releases the bus connection.
func (t *Tray) Close() {
	if t != nil && t.conn != nil {
		_ = t.conn.Close()
	}
}

// sniHandler implements the org.kde.StatusNotifierItem methods we use.
type sniHandler struct {
	actions Actions
}

// Activate fires on a primary click — used as click-to-record, which is the
// Wayland path where there is no global hotkey.
func (h *sniHandler) Activate(x, y int32) *dbus.Error {
	h.fire(h.actions.OnRecord)
	return nil
}

// SecondaryActivate fires on a middle click.
func (h *sniHandler) SecondaryActivate(x, y int32) *dbus.Error {
	h.fire(h.actions.OnRecord)
	return nil
}

// ContextMenu may be called to ask the item to show its menu.
func (h *sniHandler) ContextMenu(x, y int32) *dbus.Error { return nil }

// Scroll is invoked on scroll events, which we ignore.
func (h *sniHandler) Scroll(delta int32, orientation string) *dbus.Error { return nil }

func (h *sniHandler) fire(fn func()) {
	if fn != nil {
		go fn()
	}
}

// MenuItem is one com.canonical.dbusmenu layout node: (id, properties, children).
type MenuItem struct {
	ID       int32
	Props    map[string]dbus.Variant
	Children []dbus.Variant
}

// menuHandler implements com.canonical.dbusmenu.
type menuHandler struct {
	actions Actions
}

// GetLayout returns the whole menu (parentId 0) with its children.
func (m *menuHandler) GetLayout(parentID int32, depth int32, names []string) (uint32, MenuItem, *dbus.Error) {
	root := MenuItem{
		ID:    idRoot,
		Props: map[string]dbus.Variant{},
		Children: []dbus.Variant{
			dbus.MakeVariant(leaf(idRecord, "Record")),
			dbus.MakeVariant(leaf(idSettings, "Settings")),
			dbus.MakeVariant(leaf(idDashboard, "Dashboard")),
			dbus.MakeVariant(MenuItem{ID: -1, Props: map[string]dbus.Variant{"type": dbus.MakeVariant("separator")}}),
			dbus.MakeVariant(leaf(idQuit, "Quit")),
		},
	}
	return 1, root, nil
}

// GetGroupProperties is unused by the common desktops; return an empty set.
func (m *menuHandler) GetGroupProperties(ids []int32, names []string) ([]struct {
	ID    int32
	Props map[string]dbus.Variant
}, *dbus.Error) {
	return nil, nil
}

// AboutToShow is called before the menu opens; nothing to update.
func (m *menuHandler) AboutToShow(id int32) (bool, *dbus.Error) { return false, nil }

// Event dispatches a menu click.
func (m *menuHandler) Event(id int32, eventID string, data dbus.Variant, timestamp uint32) *dbus.Error {
	if eventID != "clicked" {
		return nil
	}
	switch id {
	case idRecord:
		m.fire(m.actions.OnRecord)
	case idSettings:
		m.fire(m.actions.OnSettings)
	case idDashboard:
		m.fire(m.actions.OnDashboard)
	case idQuit:
		m.fire(m.actions.OnQuit)
	}
	return nil
}

func (m *menuHandler) fire(fn func()) {
	if fn != nil {
		go fn()
	}
}

func leaf(id int32, label string) MenuItem {
	return MenuItem{
		ID: id,
		Props: map[string]dbus.Variant{
			"label":   dbus.MakeVariant(label),
			"type":    dbus.MakeVariant("standard"),
			"visible": dbus.MakeVariant(true),
			"enabled": dbus.MakeVariant(true),
		},
	}
}
