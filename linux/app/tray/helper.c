/*
 * C helpers for the tray binding. Kept in a .c file because the Go file uses
 * //export, which forbids definitions in its preamble.
 */
#include <libayatana-appindicator/app-indicator.h>
#include <gtk/gtk.h>

// Implemented in Go with //export.
void tbvTraySettings(GtkMenuItem *item, gpointer data);
void tbvTrayDashboard(GtkMenuItem *item, gpointer data);
void tbvTrayQuit(GtkMenuItem *item, gpointer data);

GtkWidget *tbv_menu_new(void) { return gtk_menu_new(); }

void tbv_menu_append(GtkWidget *menu, const char *label, int id) {
	GCallback cb = NULL;
	switch (id) {
	case 0: cb = G_CALLBACK(tbvTraySettings); break;
	case 1: cb = G_CALLBACK(tbvTrayDashboard); break;
	case 2: cb = G_CALLBACK(tbvTrayQuit); break;
	}
	GtkWidget *item = gtk_menu_item_new_with_label(label);
	g_signal_connect(G_OBJECT(item), "activate", cb, GINT_TO_POINTER(id));
	gtk_menu_shell_append(GTK_MENU_SHELL(menu), item);
	gtk_widget_show(item);
}

AppIndicator *tbv_indicator_new(const char *icon) {
	return app_indicator_new("typebyvoice", icon, APP_INDICATOR_CATEGORY_APPLICATION_STATUS);
}

void tbv_indicator_attach(AppIndicator *ind, GtkWidget *menu) {
	app_indicator_set_status(ind, APP_INDICATOR_STATUS_ACTIVE);
	app_indicator_set_menu(ind, GTK_MENU(menu));
}

void tbv_indicator_label(AppIndicator *ind, const char *label) {
	app_indicator_set_label(ind, label, NULL);
}
