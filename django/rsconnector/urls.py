"""
URL configuration for rsconnector project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path
from django.views.generic.base import RedirectView

urlpatterns = [
    path('console/', admin.site.urls),
    path('health', lambda request: JsonResponse({'status': 'ok', 'service': 'rs-connector-django'})),
    # Racine -> admin Django sur /console (coexiste avec le /admin du back-office Node).
    path('', RedirectView.as_view(url='/console/', permanent=False)),
    path('', include('hub.urls')),
]
