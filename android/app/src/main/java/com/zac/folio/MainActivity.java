package com.zac.folio;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Folio's own native features (files, folders, printing, system bars) — see FolioNativePlugin
        registerPlugin(FolioNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
