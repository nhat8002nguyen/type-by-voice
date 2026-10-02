package ui

import (
	"context"

	"log"

	"github.com/diamondburned/gotk4/pkg/gtk/v4"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/history"
)

// DashboardDeps are what the transcript-history window needs.
type DashboardDeps struct {
	History *history.Client
}

// ShowDashboard opens the searchable transcript history with delete and export.
func ShowDashboard(app *gtk.Application, deps DashboardDeps) {
	win := gtk.NewApplicationWindow(app)
	win.SetTitle("Type by Voice — History")
	win.SetDefaultSize(640, 520)

	box := gtk.NewBox(gtk.OrientationVertical, 10)
	box.SetMarginTop(14)
	box.SetMarginBottom(14)
	box.SetMarginStart(14)
	box.SetMarginEnd(14)

	search := gtk.NewSearchEntry()
	search.SetPlaceholderText("Search transcripts")
	box.Append(search)

	list := gtk.NewListBox()
	box.Append(list)

	refresh := func(query string) {
		page, err := deps.History.List(context.Background(), query, "")
		if err != nil {
			log.Printf("history: %v", err)
			return
		}
		for list.FirstChild() != nil {
			list.Remove(list.FirstChild())
		}
		for _, t := range page.Items {
			row := gtk.NewListBoxRow()
			caption := t.Text
			if caption == "" {
				caption = "(empty)"
			}
			row.SetChild(gtk.NewLabel(caption))
			list.Append(row)
		}
	}
	search.ConnectSearchChanged(func() { refresh(search.Text()) })

	export := gtk.NewButtonWithLabel("Export")
	export.ConnectClicked(func() {
		if _, err := deps.History.Export(context.Background()); err != nil {
			log.Printf("export: %v", err)
		}
	})
	box.Append(export)

	refresh("")
	win.SetChild(box)
	win.SetVisible(true)
}
